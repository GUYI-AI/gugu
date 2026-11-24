import { makeAutoObservable, runInAction } from 'mobx';
import {
  findSessionShellPort,
  isSessionShellUnsupported,
  onSessionpageIdentityEvent,
} from '@renderer/lib/shell-port';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { subscribeDeviceSessions } from '@/session/shared/remote-sessions/session-directory';
import { readIdentityDirectoryBridge, type IdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { agentNamesFromPeers, type SessionShellAgentName } from '@shared/lib/ipc/shell-port';
import { log } from '@renderer/utils/logger';
import { onAccountChange } from '@/lib/replica';

/** 一条会话背后的咕咕身份:它的 agent id。名字不在这里 —— 任务只有一个名字,是会话的 `title`。 */
export interface SessionAgentBinding {
  agentUserId: string;
}

/** 这张表从哪里读、听什么(默认接壳口;单测换成假的)。 */
export interface SessionAgentBindingsSource {
  /** 本机那一份;null = 没有壳(SSR / 测试),表留空。 */
  readAll(): Promise<SessionShellAgentName[]> | null;
  /** 别的机器上的:会话目录里带 agent id 的行(❌ 逐台去问)。 */
  readRemote(): SessionShellAgentName[];
  /** 会话目录变了(哪台机器的列表到了 / 变了)。 */
  onRemoteChange(cb: () => void): () => void;
  /** 开户事件(本机与每台机器合流)。 */
  onIdentityEvent(cb: (event: SessionShellAgentName) => void): () => void;
  directory(): IdentityDirectoryBridge | null | undefined;
  /** 换了登录的人(登出也算):本机那一份是按登录的人答的。 */
  onAccountChange(cb: () => void): () => void;
}

const shellSource: SessionAgentBindingsSource = {
  readAll: () => findSessionShellPort()?.agentNames() ?? null,
  readRemote: () => agentNamesFromPeers(remoteHostsStore.directoryPeers().peers),
  onRemoteChange: subscribeDeviceSessions,
  onIdentityEvent: onSessionpageIdentityEvent,
  directory: () => readIdentityDirectoryBridge(),
  onAccountChange: (cb) => onAccountChange(() => cb()),
};

/**
 * 「侧栏这一行背后是哪个 agent」—— 会话 → agent id 的绑定索引(#6092)。
 *
 * 这个问题在一屏十几行、指针一路划过去的时候每一行都要被问一次,所以答案放成**一张表**:
 *
 *  · 本机的绑定由壳口 `agentNames` 整份读一次,之后靠 `sessionpage-agent-provisioned` 事件增量更新 ——
 *    ❌ 轮询,❌ 每行各查一次(那会把整份名册读十几遍)。
 *  · #6264 别的机器上的会话:会话目录的行上带着 agent id;目录一变就再收一遍。那台机器推的事件照样合流。
 *    ❌ 逐台机器去问 —— 掉线又回来的那台会让读的人等到超时(#7016)。
 *  · 查不到就是**没有**:那条会话还没有咕咕身份(从没起过、或这家引擎不可寻址)。
 *  · 本机那一份按登录的人答(agent 身份属于账号,任务属于机器):换了人就整张忘掉,下一个人的侧栏挂上时再读 ——
 *    和重启后冷启动读到的是同一份。
 *  · 名字 ❌ 在这里:任务的名字只有一份,是会话的 `title`(宿主的 taskName)。
 */
export class SessionAgentBindings {
  /** conversationId → 绑定。不在表里 = 这条会话还没有身份。 */
  bindings = new Map<string, SessionAgentBinding>();
  /** 整份读过一次了吗。没读过与「读过、这条没有」在界面上是同一副样子,所以单独记一格备诊断。 */
  isLoaded = false;
  private started = false;
  /** 这个人的本机那一份读过了(换人后回到 false)。 */
  private read = false;
  /** 换一次人加一;读回来时已经换过人的那一份不落表。 */
  private generation = 0;

  constructor(private readonly source: SessionAgentBindingsSource = shellSource) {
    makeAutoObservable<SessionAgentBindings, 'source'>(this, { source: false });
  }

  bindingFor(sessionId: string): SessionAgentBinding | undefined {
    return this.bindings.get(sessionId);
  }

  /** 单条落表。id 缺一格都不入表。 */
  note(sessionId: string, agentUserId: string): void {
    const id = sessionId.trim();
    const agent = agentUserId.trim();
    if (!id || !agent) return;
    runInAction(() => {
      if (this.bindings.get(id)?.agentUserId !== agent) this.bindings.set(id, { agentUserId: agent });
    });
  }

  /**
   * 整份读一次。没有壳(SSR / 测试)或这个形态的壳不答这一口 → 表留空,侧栏就只是不画身份。
   * ❌ 不抛:一层「顺手告诉你这行是谁」的提示,不该把侧栏或启动流程带下去。
   */
  async load(): Promise<void> {
    const generation = this.generation;
    const reading = this.source.readAll();
    if (!reading) return;
    try {
      const rows = await reading;
      if (generation !== this.generation) return;
      this.adoptRows(rows);
      runInAction(() => {
        this.isLoaded = true;
      });
    } catch (error) {
      if (isSessionShellUnsupported(error)) return;
      log.warn('[sessionpage] 读会话身份表失败,侧栏这一轮不显示 agent 身份', { error });
    }
  }

  private adoptRows(rows: readonly SessionShellAgentName[]): void {
    for (const row of rows) this.note(row.conversationId, row.agentUserId);
  }

  /** 换了登录的人:上一个人的那份整张忘掉,等下一次 start 再读。 */
  private forget(): void {
    runInAction(() => {
      this.generation += 1;
      this.bindings.clear();
      this.isLoaded = false;
      this.read = false;
    });
  }

  /**
   * 接上事件并整份读一次。**幂等**:侧栏收起再展开会重新挂载,再点一次不该重订阅、也不该
   * 再把名册读一遍。订阅跟着应用活一辈子,所以不给退订 —— 这张表本身也是全应用一份;
   * 换了人以后(forget)下一次 start 再读一遍,那是下一个人的侧栏挂上了。
   */
  start(): void {
    if (!this.started) {
      this.started = true;
      this.source.onIdentityEvent((event) => this.note(event.conversationId, event.agentUserId));
      this.source.onRemoteChange(() => this.adoptRows(this.source.readRemote()));
      // A remote row is listed once its identity is known to the shared identity directory.
      this.source.directory()?.subscribe(() => this.adoptRows(this.source.readRemote()));
      this.source.onAccountChange(() => this.forget());
    }
    if (this.read) return;
    this.read = true;
    this.adoptRows(this.source.readRemote());
    void this.load();
  }
}

export const sessionAgentBindings = new SessionAgentBindings();
