import { computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import { platform } from '@/platform';
import { readDeviceRevision, type AccountRevisionEvent, type AccountRevisionListener } from '@/lib/accountRevisionCoordinator';
import { deviceProjectsPublishedChannel } from '@shared/core/projects/projectEvents';
import { events } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { groupRowOrder } from './project-group-layout';
import { readCachedAccountProjects, writeCachedAccountProjects } from './account-projects-cache';

export type AccountProjectsStatus = 'loading' | 'ready' | 'error';

/**
 * 这一端的本地项目表(桌面 = projectManager,别的机器上的项目按 machineOf 认机器;这台电脑 = null)。
 * 由持有项目表的一方接上(AppState);手机没有项目表,只用 projectOfLocal(id, 机器)。
 */
export type LocalProjects = {
  projects: ReadonlyMap<string, { createdAt?: string | null }>;
  machineOf(projectId: string): string | null;
  connected(deviceId: string): boolean;
};

/** 账号 revision 的订阅口(聊天那一层给,见 store/chatContext)。 */
export type SubscribeAccountRevision = (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void;

const bindingKey = (deviceId: string, localProjectId: string) => `${deviceId}\u0000${localProjectId}`;

/**
 * 账号上的项目(identity.list_my_projects,项目与机器解耦):项目就是它的项目群,一个文件夹都没有也在。
 * 侧栏、项目选择器、任务历史、手机都只从这一份认「有哪些项目、一个本地项目属于哪个项目」;❌ 各处再按群拼本地项目。
 * 什么时候再读由它自己订({@link start}),❌ 别处再叫 refresh —— 人按的「重试」除外。
 * 读不到 = status 'error',由各处画出错误和重试;❌ 退回本地拼法。列着的仍是这份上次读到的(同一份,不是别的来源):
 * 开机 / 重载时先铺上这个账号上次那份({@link restore}),读到了就换成此刻的;断网重载不会把项目区读空。
 */
export class AccountProjectsStore {
  list: readonly AccountProject[] = [];
  status: AccountProjectsStatus = 'loading';
  error: string | null = null;
  /** 这台电脑的设备 id(绑定里的 deviceId 是它 = 这台电脑上的本地项目);手机上没有 = null。 */
  localDeviceId: string | null = null;
  local: LocalProjects | null = null;
  /** 这份属于哪个账号(写缓存用);登出 / 换账号前由 {@link clear} 清掉。 */
  private accountId: string | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private generation = 0;

  constructor() {
    makeObservable<AccountProjectsStore, 'membership' | 'byBinding'>(this, {
      list: observable.ref,
      status: observable,
      error: observable,
      localDeviceId: observable,
      local: observable.ref,
      membership: computed,
      byBinding: computed,
    });
  }

  get projects(): readonly AccountProject[] {
    return this.list;
  }

  /** 列表换了就通知(给不是 observer 的组件配 useSyncExternalStore)。 */
  readonly subscribe = (listener: () => void): (() => void) => reaction(() => this.projects, listener);

  attach(local: LocalProjects): void {
    runInAction(() => { this.local = local; });
  }

  /**
   * 认出登录的是谁:换了账号先清掉上一个的,铺上这个账号上次那份,读一次;之后这几样变了再读 ——
   * 某台机器的项目记上账号 / 某台被移除(device_changed,别的电脑、手机记的经这里到);这台电脑的项目记上账号
   * (建了项目、绑了群之后那次发布,断网时是重连后那次:它们在那一刻才进 list_my_projects);这台电脑在账号里认出了自己
   * (之前那次读分不出哪些绑定是这台的)。
   * 返回的 stop 只退订、不清:界面不活跃、令牌刷新时登录的人会短暂读成空,❌ 当成登出;登出走 {@link clear}。
   */
  start(accountId: string, subscribeRevision: SubscribeAccountRevision): () => void {
    if (this.accountId !== null && this.accountId !== accountId) this.clear();
    this.restore(accountId);
    void this.refresh();
    const offs = [
      subscribeRevision('device_changed', (operations) => {
        if (operations.some((operation) => {
          const key = readDeviceRevision(operation.payload);
          return key.projects || key.removed;
        })) void this.refresh();
      }),
      events.on(deviceProjectsPublishedChannel, () => void this.refresh()),
      platform.subscribeLocalDeviceIdentified?.(() => void this.refresh()) ?? (() => {}),
    ];
    return () => offs.forEach((off) => off());
  }

  /** 铺上这个账号上次读到的那份(别的账号的那份不用),再由 refresh 换成此刻的。 */
  restore(accountId: string): void {
    this.accountId = accountId;
    if (this.list.length > 0) return;
    const cached = readCachedAccountProjects(accountId);
    if (cached.length > 0) runInAction(() => { this.list = cached; });
  }

  /** 读一次;正在读时再要一次 = 这次读完再读一遍(❌ 吞掉:那次读的可能是变之前的)。 */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    const generation = this.generation;
    // Which machine this is comes from this machine, not from the account list: read it on its own, so a list read that
    // fails (offline, a reload over the cached list) still knows which bindings are this computer's.
    const self = Promise.resolve(platform.getLocalDeviceSelfSnapshot?.()).then((self) => {
      if (generation === this.generation && self?.device_id) runInAction(() => { this.localDeviceId = self.device_id; });
    }, (error: unknown) => log.warn('[projects] this computer\'s device id could not be read', error));
    const read = import('@/lib/deviceProjects').then((cloud) => cloud.listMyAccountProjects())
      .then((list) => {
        if (generation !== this.generation) return;
        runInAction(() => {
          this.list = list;
          this.status = 'ready';
          this.error = null;
        });
        if (this.accountId) writeCachedAccountProjects(this.accountId, list);
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        log.error('[projects] read the account project list failed', error);
        runInAction(() => {
          this.status = 'error';
          this.error = error instanceof Error ? error.message : String(error);
        });
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.inFlight = null;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      });
    const both = Promise.all([self, read]).then(() => undefined);
    this.inFlight = both;
    return both;
  }

  /** 登出 / 换账号:上一个账号的项目一条不留,在途的那次读回来也不要。 */
  clear(): void {
    this.generation += 1;
    this.inFlight = null;
    this.again = false;
    this.accountId = null;
    runInAction(() => {
      this.list = [];
      this.status = 'loading';
      this.error = null;
      this.localDeviceId = null;
    });
  }

  /** (机器, 本地项目) → 它属于的项目。 */
  private get byBinding(): ReadonlyMap<string, AccountProject> {
    const map = new Map<string, AccountProject>();
    for (const project of this.projects) {
      for (const binding of project.bindings) map.set(bindingKey(binding.deviceId, binding.localProjectId), project);
    }
    return map;
  }

  /** 项目 → 项目表里有的本地项目,按 groupRowOrder 排(这台电脑 → 连着的 → 最早建的 → id)。 */
  private get membership(): ReadonlyMap<string, readonly string[]> {
    const local = this.local;
    const out = new Map<string, string[]>();
    for (const project of this.projects) {
      const members = local
        ? project.bindings.flatMap(({ deviceId, localProjectId: id }) => {
            const row = local.projects.get(id);
            if (!row) return [];
            const machine = local.machineOf(id);
            if ((machine ?? this.localDeviceId) !== deviceId) return [];
            return [{ id, machine, online: machine === null || local.connected(machine), createdAt: row.createdAt ?? null }];
          })
        : [];
      out.set(project.chatId, [...new Set(members.sort(groupRowOrder).map((member) => member.id))]);
    }
    return out;
  }

  /** 这个项目在这一端项目表里的本地项目(代表在最前);没有 = []。 */
  membersOf(chatId: string): readonly string[] {
    return this.membership.get(chatId) ?? [];
  }

  /** 这个项目由哪个本地项目画(groupRowOrder 的第一个);一个都没有 = undefined。 */
  representativeOf(chatId: string): string | undefined {
    return this.membersOf(chatId)[0];
  }

  /**
   * 这个本地项目属于哪个项目。`machine`:null = 这台电脑,设备 id = 那台机器;不给 = 按项目表认它在哪台。
   */
  projectOfLocal(localProjectId: string, machine?: string | null): AccountProject | undefined {
    const at = machine === undefined ? (this.local?.machineOf(localProjectId) ?? null) : machine;
    const deviceId = at ?? this.localDeviceId;
    return deviceId ? this.byBinding.get(bindingKey(deviceId, localProjectId)) : undefined;
  }

  project(chatId: string): AccountProject | undefined {
    return this.projects.find((project) => project.chatId === chatId);
  }
}

export const accountProjectsStore = new AccountProjectsStore();
