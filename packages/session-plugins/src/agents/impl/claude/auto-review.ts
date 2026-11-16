import { CLAUDE_PERMISSION_MODES } from './permission-modes';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { flattenSelectOptions, meetsReviewModeRequirements } from '@gugu/session-core/acp';

export const CLAUDE_REVIEWER_MODEL = 'claude-haiku-5-5';
export const CLAUDE_AUTO_REVIEW_MIN_VERSION = '2.1.302';

/** Only the selected host executable's version counts; the SDK/bridge version does not. */
export function claudeAutoReviewAvailable(version: string | undefined, model: string | null | undefined): boolean {
  return meetsReviewModeRequirements(CLAUDE_PERMISSION_MODES['ai-review'].reviewRequirements, { cliVersion: version, model });
}

/** Preserve the producer's mode list, removing auto when either prerequisite is unknown. */
export function claudeReviewConfig(options: readonly SessionConfigOption[], version?: string): SessionConfigOption[] {
  const model = options.find(option => option.category === 'model' && option.type === 'select');
  const selected = model?.type === 'select' ? model.currentValue : null;
  const choice = model?.type === 'select' ? flattenSelectOptions(model.options).find(option => option.value === selected) : undefined;
  // A default/haiku alias needs the model the producer describes, rather than an SDK default.
  const resolved = selected === 'default' || selected === 'haiku'
    ? `${choice?.name ?? ''} ${choice?.description ?? ''}`.match(/(?:claude-)?(?:opus|fable|sonnet|haiku)[- ]\d+(?:[- .]\d+)?/i)?.[0]?.replace(/[ .]/g, '-')
    : selected;
  const available = claudeAutoReviewAvailable(version, resolved);
  return options.map(option => option.category === 'mode' && option.type === 'select'
    ? { ...option, options: flattenSelectOptions(option.options).filter(choice => choice.value !== 'auto' || available) }
    : option);
}
