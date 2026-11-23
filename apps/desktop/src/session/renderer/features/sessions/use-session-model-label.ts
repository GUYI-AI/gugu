import type { SessionpageSessionSurface } from '@gugu/session-core/agents/plugins';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { effortNamesLine } from './session-config/effort-options';
import { usePlatformModelCatalog } from './session-config/platform-model-catalog';
import { runningPlatformModelId } from './session-config/platform-model-selection';
import { sessionRegistry } from './stores/session-registry';

/**
 * 「模型 · 档位」(第 16 版名片第二行):用输入框那套换算 —— 跑在咕咕模型上就是目录里的显示名(同输入框的模型钮),
 * 否则是会话记着的模型;档位是词表里的档名(同推理档下拉)。都不知道 = null。
 */
export function useSessionModelLabel(sessionId: string, surface: SessionpageSessionSurface): string | null {
  const { translate } = useSessionMessages();
  const session = sessionRegistry.get(sessionId)?.sessions.get(sessionId);
  const catalog = usePlatformModelCatalog(session?.data.providerId ?? null, surface, sessionId);
  const running = runningPlatformModelId(catalog.sessionSelection, session?.data.model, catalog.models.map((model) => model.id));
  const model = running ? catalog.models.find((entry) => entry.id === running)?.displayName ?? running : session?.data.model ?? null;
  const effort = session?.data.effort ? effortNamesLine([session.data.effort], translate) ?? session.data.effort : null;
  return [model, effort].filter(Boolean).join(' · ') || null;
}
