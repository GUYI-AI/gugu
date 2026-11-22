import { getPlugin } from '@main/core/agents/plugin-registry';
import type { Session } from '@shared/core/sessions/sessions';

/**
 * 终端腿停掉再起,会不会接回**原来那条**对话。闲置回收只停接得回来的(spec idle-reclaim)。
 *
 * 续跑 argv 指名的就是库里记着的 `session_id`(`resolveAgentSessionCommandArgs`),所以按这一家声明的
 * `sessions.tuiResume` 判:
 * - `caller-id`:库里记着一条 id 就接得回来(首启时咕咕交给它的,或引擎后来报回的);
 * - `provider-id`:库里得记着它自己报回来的原生 id(≠ 会话 id),且过得了这一家的 id 校验 ——
 *   否则 argv 会退到按 cwd 猜最近一条,或干脆新开。
 * 没声明 = 续不回指定的那一条。
 */
export function tuiResumesExactly(session: Session): boolean {
  const plugin = getPlugin(session.providerId);
  const mode = plugin.capabilities.sessions.tuiResume;
  const stored = session.providerSessionId;
  if (!mode || !stored) return false;
  if (mode === 'caller-id') return true;
  if (stored === session.id) return false;
  const validate = plugin.behavior.sessions?.validateProviderSessionId;
  return validate ? validate(stored) : true;
}
