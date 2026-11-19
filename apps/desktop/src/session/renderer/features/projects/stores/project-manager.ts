import { revalidateScreenSessions } from '@renderer/app/screen-layout-actions';
import { makeObservable, observable, runInAction } from 'mobx';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { machineLinkState, subscribeMachineLink } from '@renderer/lib/machine-clients';
import { appState } from '@renderer/lib/stores/app-state';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { log } from '@renderer/utils/logger';
import { foldersChangedChannel, type FolderRecord } from '@shared/core/folders/folders';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import { type LocalProject } from '@shared/projects';
import type { ProjectViewSnapshot } from '@shared/view-state';
import { createUnmountedProject, isMountedProject, isUnmountedProject, type ProjectStore } from './project';
import { reconcileSessionProjectLocations } from '@renderer/features/sessions/restore-session-projects';
import type { SessionProjectLocation } from '@shared/core/projects/session-project-references';
import { folderAsProject } from '@renderer/features/folders/folder-project';

/**
 * @@@group-folders — every folder on this computer and on each connected machine, one store per folder (keyed by its
 * workspace id: a session's `projectId` names it), mounted when a session page needs its sessions, git state or settings.
 * The folders come from each machine's own list (rpc.folders.listAllFolders); which group a folder is bound to is read
 * from the group folders store. Not here: creating a group or binding a folder (the group page, folders/*).
 */
export class ProjectManagerStore {
  projects = observable.map<string, ProjectStore>();
  private _projectMountPromises = new Map<string, Promise<void>>();
  /** ensureMounted 在等那台机器连上的文件夹(同一个只等一份)。 */
  private _awaitingLink = new Map<string, Promise<void>>();
  private _loadPromise: Promise<void> | null = null;
  private _disposeFoldersChangedEvent: (() => void) | null = null;
  private _disposeSessionCreatedEvent: (() => void) | null = null;

  constructor() {
    makeObservable(this, { projects: observable });

    // This computer's folders changed (bound, unbound, a new one recorded): read its list again. Another machine's are
    // followed by remote-hosts-store on that machine.
    this._disposeFoldersChangedEvent = events.on(foldersChangedChannel, () => {
      void rpc.folders.listAllFolders()
        .then((folders) => this.syncLocalFolders(folders))
        .catch((error: unknown) => log.error('Failed to read this computer\'s folders', { error }));
    });
    // A session created in a folder that is not mounted yet: mount the folder (its session list then holds it), then
    // hand the session to its sessionManager.
    this._disposeSessionCreatedEvent = events.on(sessionCreatedChannel, ({ session }) => {
      const project = this.projects.get(session.projectId);
      if (project && isMountedProject(project)) return;
      void this.ensureProjectLoaded(session.projectId)
        .then(() => {
          const sessionManager = this.projects.get(session.projectId)?.mountedProject?.sessionManager;
          if (!sessionManager) {
            throw new Error(`Folder ${session.projectId} did not mount for session ${session.id}`);
          }
          sessionManager.acceptCreatedSession(session);
        })
        .catch((error: unknown) => {
          log.error('Failed to attach externally created session', {
            folderId: session.projectId,
            sessionId: session.id,
            error,
          });
        });
    });
  }

  dispose(): void {
    this._disposeFoldersChangedEvent?.();
    this._disposeFoldersChangedEvent = null;
    this._disposeSessionCreatedEvent?.();
    this._disposeSessionCreatedEvent = null;
  }

  load(): Promise<void> {
    if (!this._loadPromise) {
      this._loadPromise = this._doLoad();
    }
    return this._loadPromise;
  }

  async ensureProjectLoaded(projectId: string): Promise<void> {
    if (!this.projects.has(projectId)) {
      const folder = (await rpcOn(machineRegistry.machineOf(projectId)).folders.listAllFolders()).find((candidate) => candidate.id === projectId);
      if (!folder) throw new Error(`Folder ${projectId} was not found on its machine`);
      runInAction(() => {
        if (!this.projects.has(projectId)) this.projects.set(projectId, createUnmountedProject(folderAsProject(folder), 'idle'));
      });
    }
    await this.mountProject(projectId);
  }

  /** The task home folder on that machine (null = this computer), recorded there on first use; its store is mounted. */
  async ensureTaskHome(machine: string | null = null): Promise<string> {
    const folder = await rpcOn(machine).folders.ensureTaskHome();
    if (machine) machineRegistry.register(machine, [folder.id]);
    else machineRegistry.claimLocal([folder.id]);
    runInAction(() => {
      if (!this.projects.has(folder.id)) this.projects.set(folder.id, createUnmountedProject(folderAsProject(folder), 'idle'));
    });
    await this.mountProject(folder.id);
    return folder.id;
  }

  /** This computer's list as it is now: new folders added (and mounted), changed groups applied, gone ones removed. */
  private syncLocalFolders(folders: readonly FolderRecord[]): void {
    const keep = new Set(folders.map((folder) => folder.id));
    const added: string[] = [];
    machineRegistry.claimLocal([...keep]);
    runInAction(() => {
      for (const folder of folders) {
        const project = folderAsProject(folder);
        const known = this.projects.get(folder.id);
        if (known?.data && known.data.kind !== project.kind) known.data = { ...known.data, kind: project.kind };
        if (!known) {
          this.projects.set(folder.id, createUnmountedProject(project, 'idle'));
          added.push(folder.id);
        }
      }
      for (const [id, store] of [...this.projects]) {
        if (keep.has(id) || machineRegistry.machineOf(id) !== null) continue;
        store.mountedProject?.dispose();
        this.projects.delete(id);
      }
    });
    for (const id of added) {
      void this.mountProject(id).catch((error: unknown) => log.error('Failed to mount a new folder', { folderId: id, error }));
    }
    appState.navigation.revalidate();
  }

  private async _doLoad(): Promise<void> {
    const rawProjects = (await rpc.folders.listAllFolders()).map(folderAsProject);
    const toMount: string[] = [];
    runInAction(() => {
      // #581 本机的清单说了算:别的机器先登记过的同一个 id(它的账号副本 / 应答里写着这台电脑的项目)换成本机这一份,
      // 从此认不走(claimLocal);❌ 见它已在表里就跳过 —— 那样本机项目只剩一份指向那台机器的副本。
      const claimed = rawProjects.filter((p) => machineRegistry.machineOf(p.id) !== null).map((p) => p.id);
      machineRegistry.claimLocal(rawProjects.map((p) => p.id));
      for (const p of rawProjects) {
        const existing = this.projects.get(p.id);
        if (existing && !claimed.includes(p.id)) continue;
        existing?.mountedProject?.dispose();
        this.projects.set(p.id, createUnmountedProject(p, 'idle'));
        toMount.push(p.id);
      }
    });
    // 首帧不等挂载(gugu #2318):两个启动入口都拿 load() 当渲染闸门,清单入 store 即返回,
    // 挂载在后台继续;侧栏/项目页按 unmounted/bootstrapping 渐进就绪,视图本就
    // 以 kind!=='ready' 守卫非就绪态。mountProject 各自兜错,allSettled 语义不变。
    void Promise.allSettled(toMount.map((id) => this.mountProject(id)));
  }

  /**
   * 要用这个文件夹的会话了(会话页要画它、在它的一行上动手):挂上它。**挂载的唯一入口** —— 别的机器上的文件夹列出时
   * 不挂(行来自会话目录,见 sidebar-store),只在这里挂;那台机器此刻没连上就等它连上再挂。
   */
  ensureMounted(projectId: string): Promise<void> {
    const machine = machineRegistry.machineOf(projectId);
    if (!machine || machineLinkState(machine) === 'open') return this.mountProject(projectId);
    const waiting = this._awaitingLink.get(projectId);
    if (waiting) return waiting;
    const promise = new Promise<void>((resolve, reject) => {
      const off = subscribeMachineLink(machine, () => {
        if (machineLinkState(machine) !== 'open') return;
        off();
        this._awaitingLink.delete(projectId);
        this.mountProject(projectId).then(resolve, reject);
      });
    });
    this._awaitingLink.set(projectId, promise);
    return promise;
  }

  mountProject(projectId: string): Promise<void> {
    const inFlight = this._projectMountPromises.get(projectId);
    if (inFlight) return inFlight;

    const project = this.projects.get(projectId);
    if (!project || !isUnmountedProject(project)) return Promise.resolve();
    // #6264 别的机器上的项目:那台机器连着才挂(连上时 machines 那边会再调一次),❌ 离线时挂成一个错误态。
    const machine = machineRegistry.machineOf(projectId);
    if (machine && machineLinkState(machine) !== 'open') return Promise.resolve();

    runInAction(() => {
      project.phase = 'opening';
      project.error = undefined;
      project.errorCode = undefined;
    });

    const promise = Promise.all([
      rpc.folderRuntime.openFolder(projectId),
      viewStateCache.read(`project:${projectId}`),
    ])
      .then(async ([openResult, savedSnapshot]) => {
        if (!openResult.success) {
          runInAction(() => {
            const current = this.projects.get(projectId);
            if (current && isUnmountedProject(current)) {
              current.phase = 'error';
              if (openResult.error.type === 'path-not-found') {
                current.error = openResult.error.path;
                current.errorCode = 'path-not-found';
              } else if (openResult.error.type === 'path-access-blocked') {
                current.error = openResult.error.path;
                current.errorCode = 'path-access-blocked';
              } else {
                current.error = openResult.error.message;
                current.errorCode = undefined;
              }
            }
          });
          return;
        }
        runInAction(() => {
          const current = this.projects.get(projectId);
          if (current && isUnmountedProject(current)) {
            // Patch repositoryWorkspaceId from the main process response so the
            // mounted project data is up-to-date (fixes stale null after creation).
            const projectData = current.data;
            projectData.baseRef = openResult.data.baseRef;
            if (openResult.data.repositoryWorkspaceId && projectData) {
              projectData.repositoryWorkspaceId = openResult.data.repositoryWorkspaceId;
            }
            current.transitionToMounted(
              projectData,
              savedSnapshot as ProjectViewSnapshot | undefined
            );
          }
        });
        // Load the task list before provisioning so the tasks map is populated.
        const sessionManager = this.projects.get(projectId)?.mountedProject?.sessionManager;
        if (sessionManager) {
          await sessionManager.loadSessions();
          const nav = appState.navigation;
          // 任务列表到位之后补跑一次路由校验。守卫判的就是这份列表,而它**第一次**跑是在冷启动
          // 恢复快照那一刻 —— 那时项目还没挂载、sessionManager 还不存在,守卫只能一律放行,之后再也
          // 不跑。少了这一次,恢复到一个已归档(或已消失)的任务就会原样停在那儿;更糟的是下面这段
          // 会把它 provision 起来,等于把一项归档任务反向复活。
          //
          // 顺序要紧:先校验、后 provision。反过来就是先复活再问该不该去。
          nav.revalidate();
          // 这屏上摆着的会话块同一刻核一次(重启读回来的摆法里,可能有已经删掉 / 归档的)。
          revalidateScreenSessions(projectId, (sessionId) => {
            const session = sessionManager.sessions.get(sessionId);
            return session !== undefined && !session.data.archivedAt;
          });
          const navParams = nav.viewParamsStore['session'] as
            | { projectId?: string; sessionId?: string }
            | undefined;
          const navSessionId =
            nav.currentViewId === 'session' && navParams?.projectId === projectId
              ? navParams.sessionId
              : undefined;
          if (navSessionId) {
            sessionManager.provisionSession(navSessionId).catch(() => {});
          }
        }
      })
      .catch((err: unknown) => {
        runInAction(() => {
          const current = this.projects.get(projectId);
          if (current && isUnmountedProject(current)) {
            current.phase = 'error';
            current.error = err instanceof Error ? err.message : String(err);
            current.errorCode = undefined;
          }
        });
        throw err;
      })
      .finally(() => {
        this._projectMountPromises.delete(projectId);
      });

    this._projectMountPromises.set(projectId, promise);
    return promise;
  }

  /**
   * #6264 一台别的机器上的项目清单(那台机器连上时 / 离线时取上次记下的):并入同一张项目表,
   * 与本机项目同一套界面(照 Zed:机器是项目的属性)。**只登记,❌ 挂**:侧栏的行来自会话目录,
   * 要用到某个项目时才由 ensureMounted 挂上。清单里没有了的那台机器的项目拿掉(在那台机器上删掉的)。
   */
  syncMachineProjects(deviceId: string, projects: readonly LocalProject[], sessions: readonly SessionProjectLocation[] = []): void {
    machineRegistry.register(
      deviceId,
      projects.map((project) => project.id)
    );
    const keep = new Set(projects.map((project) => project.id));
    runInAction(() => {
      for (const project of projects) {
        const known = this.projects.get(project.id);
        // 重连后的分类覆盖旧副本,保留已挂载的会话;远端不能改写本机项目的类别(#581)。
        if (known?.data && machineRegistry.machineOf(project.id) === deviceId && known.data.kind !== project.kind) {
          known.data = { ...known.data, kind: project.kind };
        }
        if (!known) this.projects.set(project.id, createUnmountedProject(project, 'idle'));
      }
      reconcileSessionProjectLocations(sessions);
      for (const [id, store] of [...this.projects]) {
        if (keep.has(id)) continue;
        if (machineRegistry.machineOf(id) !== deviceId) continue;
        store.mountedProject?.dispose();
        this.projects.delete(id);
      }
    });
    // 那台机器的清单(连上读到的 / 账号上那份)并进来了:停在它的某个项目 / 会话上「还不知道」的那一页按此刻的重判。
    appState.navigation.revalidate();
  }

  /** 那台机器又连上了:已挂着的项目重读任务列表(断开那段时间的推送收不到)。 */
  refreshMachineProjects(deviceId: string): void {
    for (const [id, store] of this.projects) {
      if (machineRegistry.machineOf(id) !== deviceId) continue;
      const sessionManager = store.mountedProject?.sessionManager;
      if (sessionManager) {
        void sessionManager.resync().catch((error: unknown) =>
          log.warn('Failed to resync a project on another machine', { projectId: id, deviceId, error })
        );
      }
    }
  }

  /** 那台机器被移除 / 换了账号:它的项目从表里拿掉。 */
  dropMachine(deviceId: string): void {
    runInAction(() => {
      for (const [id, store] of [...this.projects]) {
        if (machineRegistry.machineOf(id) !== deviceId) continue;
        store.mountedProject?.dispose();
        this.projects.delete(id);
      }
    });
  }

}
