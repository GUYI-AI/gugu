import type { RemovedSessionIdentity } from '@gugu/core/shared/sessionArchival';

/** Identity belongs to the host; the session backend owns archive/restore ordering. */
export interface SessionIdentityHost {
  /** Current authenticated host context; no credentials cross this boundary. */
  attachmentCreationContext?(): Promise<{ ownerId: string; deviceId: string }>;
  ensureAgentAddress?(target: { projectId: string; sessionId: string }): Promise<{ chatId: string; agentUserId: string }>;
  archive(sessionId: string, confirmedRemoval?: RemovedSessionIdentity): Promise<RemovedSessionIdentity | null>;
  release(identity: RemovedSessionIdentity): Promise<void>;
  restore(target: { projectId: string; sessionId: string }, identity: RemovedSessionIdentity): Promise<void>;
  /**
   * 永久删除(已归档 → 永久删除)要删的身份:这条会话名下**每一个**被移除过的(当前的 + 每次「移出身份归档 →
   * 恢复」在墓碑里按会话记下的)。没有就是 []。
   */
  historyIdentities?(sessionId: string, current: RemovedSessionIdentity | null): Promise<string[]>;
  /**
   * 永久删除的云端那一半:这些已移除身份的私聊历史一起删(一次 ≤50 个),身份行留作墓碑。返回云端回执里真删掉的 id。
   * 没接上(无头单机、测试)= undefined:有身份要删时调用方把这些行记成失败,❌ 当成「云端没东西」。
   */
  purgeHistory?(agentUserIds: string[]): Promise<string[]>;
}

let host: SessionIdentityHost | null = null;

export function setSessionIdentityHost(next: SessionIdentityHost | null): void {
  host = next;
}

export function sessionIdentityHost(): SessionIdentityHost {
  if (!host) throw new Error('Removing the identity needs a connection; retry, or archive without removing it.');
  return host;
}
