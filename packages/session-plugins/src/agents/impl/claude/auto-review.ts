import { CLAUDE_PERMISSION_MODES } from './permission-modes';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { flattenSelectOptions, meetsReviewModeRequirements, meetsReviewModeVersion } from '@gugu/session-core/acp';
import { cliRefusesAutoMode } from '@gugu/session-core/models/auto-review-model';

export const CLAUDE_REVIEWER_MODEL = 'claude-haiku-5-5';
export const CLAUDE_AUTO_REVIEW_MIN_VERSION = '2.1.302';

export type ClaudeAutoReviewer = { label: string; kind: 'platform' | 'connection' };

/** Server review ignores the chosen model; pin client review in the protected session document. */
export function claudeReviewSettings(settings: Record<string, unknown>, modelId = CLAUDE_REVIEWER_MODEL): Record<string, unknown> {
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  return { ...settings, env: { ...env, CLAUDE_CODE_AUTO_MODE_MODEL: modelId, CLAUDE_CODE_AUTO_MODE_SERVER: '0' } };
}

/** Only the selected host executable's version counts; the SDK/bridge version does not. */
export function claudeAutoReviewAvailable(version: string | undefined, model: string | null | undefined): boolean {
  return meetsReviewModeRequirements(CLAUDE_PERMISSION_MODES['ai-review'].reviewRequirements, { cliVersion: version, model });
}

/**
 * A gateway session (platform / custom connection) whose reviewer the host resolved: the main model only has to be
 * one the CLI runs Auto mode on (anything but Claude 4.5 and older), on a CLI that honours the named reviewer.
 */
export function claudeGatewayReviewAvailable(version: string | undefined, model: string | null | undefined): boolean {
  return !!model && meetsReviewModeVersion(CLAUDE_PERMISSION_MODES['ai-review'].reviewRequirements, version) && !cliRefusesAutoMode(model);
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

export type ClaudeReviewVerdict = {
  /** The host's launch-time verdict. Undefined = a native login: the producer's own model rule decides. */
  allowed?: boolean;
  /** Show Auto mode disabled (with `reason`) rather than hiding it. */
  unavailable?: boolean;
  byHaiku?: boolean;
  reviewer?: ClaudeAutoReviewer;
  /** A message key saying why Auto mode is off. */
  reason?: string;
};

/** Whether `model` keeps Auto mode under this connection's verdict (the menu and a model switch use the same rule). */
export function claudeReviewModelAllowed(options: readonly SessionConfigOption[], version: string | undefined, model: string | null | undefined, hostResolved: boolean): boolean {
  return hostResolved ? claudeGatewayReviewAvailable(version, model) : claudeReviewModelAvailable(options, version, model);
}

/** Preserve the producer's mode list, removing auto when either prerequisite is unknown. */
export function claudeReviewConfig(options: readonly SessionConfigOption[], version?: string, verdict: ClaudeReviewVerdict = {}): SessionConfigOption[] {
  const model = options.find(option => option.category === 'model' && option.type === 'select');
  const current = model?.type === 'select' ? model.currentValue : null;
  const hostResolved = verdict.allowed !== undefined;
  const available = claudeReviewModelAllowed(options, version, current, hostResolved);
  // On a gateway, Claude 4.5 and older stay visible but off, saying so: no reviewer choice would turn them on.
  const refused = hostResolved && !available && cliRefusesAutoMode(current);
  const allowed = available && (verdict.allowed ?? true);
  const unavailable = verdict.unavailable === true || refused;
  const reason = refused ? 'taskConfig.reviewMainModelUnsupported' : verdict.reason;
  // A host verdict that keeps Auto mode off is shown with its reason; a CLI that cannot run it on this model hides it.
  const keep = available ? allowed || unavailable : refused;
  const marked = unavailable || verdict.byHaiku || (allowed && verdict.reviewer);
  return options.map(option => option.category === 'mode' && option.type === 'select'
    ? { ...option, options: flattenSelectOptions(option.options).filter(choice => choice.value !== 'auto' || keep).map(choice => choice.value === 'auto' && marked ? { ...choice, _meta: {
      ...choice._meta, 'gugu:auto-review-disabled': !allowed, 'gugu:auto-review-haiku': allowed && verdict.byHaiku === true,
      ...(allowed && verdict.reviewer ? { 'gugu:auto-reviewer': verdict.reviewer } : {}),
      ...(!allowed && reason ? { 'gugu:auto-review-reason': reason } : {}),
    } } : choice) }
    : option);
}
