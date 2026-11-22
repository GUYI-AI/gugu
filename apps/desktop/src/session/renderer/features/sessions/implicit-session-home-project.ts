import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { replica } from '@/lib/replica';

/**
 * 隐藏工作区准备失败是**已知产品错误**，所以这里只抛稳定语义码，不抛成品文案：
 * 文案在 render boundary（新建会话页）按当前 locale 映射。`detail` 是底层原始诊断，
 * 原样带出、不改写，也不进 catalog。
 */
export type ImplicitSessionHomeProjectFailure =
  /** 解析成功但没有可用的工作区 id —— 只能请用户自己选一个项目。 */
  | 'unavailable'
  | 'pending'
  | 'create-failed'
  | 'open-failed';

export class ImplicitSessionHomeProjectError extends Error {
  constructor(
    readonly reason: ImplicitSessionHomeProjectFailure,
    readonly detail?: string
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ImplicitSessionHomeProjectError';
  }
}

/**
 * The task home on this computer: the app-owned folder a task in no group runs in (bound to no group, Q5). The host
 * records it on first use (rpc.folders.ensureTaskHome); its id differs per machine. Another machine's is
 * remoteHostsStore.ensureTaskWorkspace (#609).
 */
export async function ensureImplicitSessionHomeProjectId(): Promise<string> {
  try {
    return await getProjectManagerStore().ensureTaskHome(null);
  } catch (error) {
    throw new ImplicitSessionHomeProjectError('open-failed', error instanceof Error ? error.message : String(error));
  }
}

/** The task home on this computer, ready for this run (read once per account; a failure is an `ImplicitSessionHomeProjectError`). */
export const implicitSessionHome = replica({
  name: 'implicitSessionHome',
  scope: 'account',
  networkMode: 'always',
  read: () => ensureImplicitSessionHomeProjectId(),
  fresh: Infinity,
});
