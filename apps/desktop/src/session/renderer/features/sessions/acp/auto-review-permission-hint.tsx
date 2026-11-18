import { classifyProviderPermissionMode, type ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import type { ComposerPermissionModeOption } from '@gugu/session-ui/react/components';
import { ShieldCheck } from '@/lib/icons';
import { translateSessionMessage } from '@renderer/localization/locale-store';

export type ReviewCostSource = 'platform' | 'subscription' | 'api-key' | 'unknown';

/** The first release never changes the reviewer's connection after launch. */
export function withAutoReviewHint(
  options: Record<string, ComposerPermissionModeOption> | null,
  providerId: string | null | undefined,
  source: ReviewCostSource,
  modeMap?: ProviderPermissionModeMap,
) {
  if (!options) return null;
  const key = source === 'platform' ? 'taskConfig.reviewCostPlatform'
    : source === 'api-key' ? 'taskConfig.reviewCostApiKey'
    : source === 'subscription' && providerId === 'claude' ? 'taskConfig.reviewCostClaude'
    : source === 'subscription' && providerId === 'codex' ? 'taskConfig.reviewCostChatGPT' : null;
  return Object.fromEntries(Object.entries(options).map(([id, option]) => {
    const auto = modeMap ? classifyProviderPermissionMode(id, modeMap) === 'ai-review' : id === 'ai-review';
    return [id, auto ? { ...option, icon: <ShieldCheck />, detail: key ? translateSessionMessage(key) : undefined } : option];
  }));
}
