import { CLAUDE_PERMISSION_MODES } from './permission-modes';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { flattenSelectOptions, meetsReviewModeRequirements } from '@gugu/session-core/acp';

export const CLAUDE_REVIEWER_MODEL = 'claude-haiku-5-5';
export const CLAUDE_AUTO_REVIEW_MIN_VERSION = '2.1.302';

/** Server review ignores the chosen model; pin client review in the protected session document. */
export function claudeReviewSettings(settings: Record<string, unknown>, modelId = CLAUDE_REVIEWER_MODEL): Record<string, unknown> {
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  return { ...settings, env: { ...env, CLAUDE_CODE_AUTO_MODE_MODEL: modelId, CLAUDE_CODE_AUTO_MODE_SERVER: '0' } };
}

/** Only the selected host executable's version counts; the SDK/bridge version does not. */
export function claudeAutoReviewAvailable(version: string | undefined, model: string | null | undefined): boolean {
  return meetsReviewModeRequirements(CLAUDE_PERMISSION_MODES['ai-review'].reviewRequirements, { cliVersion: version, model });
}

/** Resolve current or target aliases from the same native model choices. */
export function claudeReviewModelAvailable(options: readonly SessionConfigOption[], version: string | undefined, selected: string | null | undefined): boolean {
  const model = options.find(option => option.category === 'model' && option.type === 'select');
  const choice = model?.type === 'select' ? flattenSelectOptions(model.options).find(option => option.value === selected) : undefined;
  // A default/haiku alias needs the model the producer describes, rather than an SDK default.
  const alias = selected?.replace(/\[.*\]$/, '');
  const resolved = alias === 'default' || alias === 'haiku' || alias === 'sonnet'
    ? `${choice?.name ?? ''} ${choice?.description ?? ''}`.match(/(?:claude-)?(?:opus|fable|sonnet|haiku)[- ]\d+(?:[- .]\d+)?/i)?.[0]?.replace(/[ .]/g, '-')
    : selected;
  return claudeAutoReviewAvailable(version, resolved);
}

/** Preserve the producer's mode list, removing auto when either prerequisite is unknown. */
export function claudeReviewConfig(options: readonly SessionConfigOption[], version?: string, autoReviewAllowed = true, unavailable = false, byHaiku = false): SessionConfigOption[] {
  const model = options.find(option => option.category === 'model' && option.type === 'select');
  const available = claudeReviewModelAvailable(options, version, model?.type === 'select' ? model.currentValue : null);
  return options.map(option => option.category === 'mode' && option.type === 'select'
    ? { ...option, options: flattenSelectOptions(option.options).filter(choice => choice.value !== 'auto' || (available && (autoReviewAllowed || unavailable))).map(choice => choice.value === 'auto' && (unavailable || byHaiku) ? { ...choice, _meta: { ...choice._meta, 'gugu:auto-review-disabled': !autoReviewAllowed, 'gugu:auto-review-haiku': byHaiku } } : choice) }
    : option);
}
