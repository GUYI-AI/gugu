import { pluginRegistry } from '@gugu/session-plugins/agents';
import type { Session } from '@shared/core/sessions/sessions';

export const FORK_SESSION_ID_MISSING_MESSAGE =
  'fork session exited without reporting a new resumable session id';

/**
 * Resolves the session id and resume flag to pass to the agent CLI.
 *
 * 续跑只认库里记着的那一格 `session_id`(`providerSessionId`):它就是引擎那边真实存在的会话。
 * - 咕咕铸 id 的家(claude `--session-id <conversation.id>`)首启时这一格就等于 conversation.id,两者一样;
 * - 引擎铸 id 的场合(claude `--fork-session` 的子会话、通用模式换到编程模式时 ACP 适配器铸的 id、
 *   codex 这类经 hook / 控制通道报回的 id)这一格是引擎的 id —— 用 conversation.id 续会指向一条
 *   根本不存在的会话(claude:`No conversation found with session ID`)。
 * 首启(不续跑)仍交 conversation.id:那是咕咕交给引擎的新会话 id。
 *
 * 声明了 `sessions.resumeNeedsProviderId` 的家(Droid / Codex …)缺原生 id 时**不许假装在续**:`--last` 之类
 * 会按 cwd 猜一条,猜中与猜不中都不是用户点的那条。
 */
export function resolveAgentSessionCommandArgs(
  session: Session,
  isResuming: boolean,
  options: { requireProviderSessionId?: boolean } = {}
): { cliSessionId: string; isResuming: boolean } {
  if (!isResuming) return { cliSessionId: session.id, isResuming };
  const nativeSessionId = session.providerSessionId;
  const hasNativeId = !!nativeSessionId && nativeSessionId !== session.id;
  if (!hasNativeId && pluginRegistry.get(session.providerId)?.capabilities.sessions.resumeNeedsProviderId) {
    return { cliSessionId: session.id, isResuming: options.requireProviderSessionId === false };
  }
  return { cliSessionId: nativeSessionId || session.id, isResuming: true };
}

export function resolveForkResumeCommandArgs(
  session: Session,
  sourceProviderSessionId?: string,
): { cliSessionId: string; isResuming: true } {
  const resolved = resolveAgentSessionCommandArgs(session, true);
  if (
    !resolved.isResuming ||
    (sourceProviderSessionId !== undefined && session.providerSessionId === sourceProviderSessionId)
  ) {
    throw new Error(FORK_SESSION_ID_MISSING_MESSAGE);
  }
  return { cliSessionId: resolved.cliSessionId, isResuming: true };
}
