import { classifyProviderPermissionMode, type ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import type { ComposerPermissionModeOption } from '@gugu/session-ui/react/components';
import { ShieldCheck } from '@/lib/icons';
import { UI_EVENTS } from '@/lib/uiEvents';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

export type ReviewCostSource = 'platform' | 'subscription' | 'api-key' | 'unknown';

/** Reasons Auto mode is off that picking another review model in Settings fixes. */
const REVIEWER_FIXABLE_REASONS = [
  'taskConfig.reviewNoReviewer',
  'taskConfig.reviewPreferenceUnavailable',
  'taskConfig.reviewPlatformReviewerNeedsPlatformSession',
  'taskConfig.reviewReviewerExcluded',
] as const satisfies readonly SessionMessageLookupKey[];

/** The host's message key for why Auto mode is off; anything it does not name reads as the generic line. */
export function autoReviewReason(reason: string | undefined): SessionMessageLookupKey {
  return reason?.startsWith('taskConfig.review') ? reason as SessionMessageLookupKey : 'taskConfig.reviewUnavailable';
}

export function openReviewModelSetting(): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'model', action: 'review-model' } }));
}

function ChooseReviewModel() {
  return <button type="button" className="mt-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
    data-testid="auto-review-choose-model"
    onClick={(event) => { event.stopPropagation(); openReviewModelSetting(); }}>
    {translateSessionMessage('taskConfig.reviewChooseModel')}
  </button>;
}

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
  // Descriptions arrive translated (localizePermissionModeOptions); compare in the same locale.
  const fixable = new Set<string>(REVIEWER_FIXABLE_REASONS.map(reason => translateSessionMessage(reason)));
  return Object.fromEntries(Object.entries(options).map(([id, option]) => {
    const auto = modeMap ? classifyProviderPermissionMode(id, modeMap) === 'ai-review' : id === 'ai-review';
    if (!auto) return [id, option];
    const description = option.disabled ? option.description ?? translateSessionMessage('taskConfig.reviewUnavailable') : option.description;
    // The host named the reviewer: say who reviews and who pays, instead of the route's generic line.
    const reviewerLine = option.reviewer
      ? translateSessionMessage(option.reviewer.kind === 'platform' ? 'taskConfig.reviewByPlatformModel' : 'taskConfig.reviewByConnectionModel', { name: option.reviewer.label })
      : null;
    const detail = option.disabled
      ? description && fixable.has(description) ? <ChooseReviewModel /> : undefined
      : reviewerLine ?? (option.reviewByHaiku
        ? <>{translateSessionMessage('taskConfig.reviewByHaiku')}<br />{key ? translateSessionMessage(key) : null}</>
        : key ? translateSessionMessage(key) : undefined);
    return [id, { ...option, icon: <ShieldCheck />, ...(description !== undefined ? { description } : {}), detail }];
  }));
}
