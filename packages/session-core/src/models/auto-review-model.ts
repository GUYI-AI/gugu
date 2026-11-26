import { z } from 'zod';
import type { CustomModelConnection } from './custom-model';

/**
 * The one reviewer the user picks in Settings → Auxiliary models. It never changes the conversation model.
 * A connection model reviews sessions on any route that can reach it (#auto-review-relax); a platform model
 * reviews platform sessions on the same session ticket.
 */
export const autoReviewModelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('custom'),
    connectionId: z.string().uuid(),
    modelId: z.string().trim().min(1).max(200),
  }),
  z.object({
    kind: z.literal('platform'),
    modelId: z.string().trim().min(1).max(200),
  }),
]).nullable();
export type AutoReviewModel = z.infer<typeof autoReviewModelSchema>;

/**
 * Claude Code's own main-model gate for Auto mode (docs: permission-modes, "Provider and model"):
 * Opus/Sonnet 4.6 or later, Haiku 5.5, or Fable. Older Claude models start in Manual on every provider.
 */
export const CLAUDE_AUTO_MODE_MODEL_PATTERN = '^(?:claude-)?fable(?:-|$)|^(?:claude-)?opus(?:$|-(?:4-(?:[6-9]|[1-9]\\d+)|(?:[5-9]|[1-9]\\d+))(?:-|$))|^(?:claude-)?sonnet-(?:4-(?:[6-9]|[1-9]\\d+)|(?:[5-9]|[1-9]\\d+))(?:-|$)|^(?:claude-)?haiku-5-5(?:-|$)';
const supportedClaude = new RegExp(CLAUDE_AUTO_MODE_MODEL_PATTERN, 'i');

/** Normalize known full provider IDs, never translated labels. */
function claudeReviewIdentity(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').split('/').at(-1)!
    .replace(/^(?:us|eu|apac|global)\./, '').replace(/^anthropic\./, '')
    .replace(/@20\d{6}$/, '').replace(/-v\d+(?::\d+)?$/, '').replace(/-20\d{6}$/, '')
    .replace(/^(opus|sonnet|haiku)-(\d)/, 'claude-$1-$2');
}

/**
 * CLI 2.1.310 Oqo/UB; https://code.claude.com/docs/en/permission-modes#when-your-model-doesnt-review
 * These IDs are ignored as CLAUDE_CODE_AUTO_MODE_MODEL: the CLI swaps in its default classifier, which on a
 * gateway falls back to the session's own model (measured on 2.1.309: `ignoring … safeguards refuse`).
 */
export function canSpecifyClaudeReviewModel(modelId: string): boolean {
  const id = claudeReviewIdentity(modelId);
  return !!id && !['default', 'opus', 'sonnet', 'haiku', 'fable',
    'claude-opus-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].includes(id);
}

export function isHaikuReviewModel(modelId: string): boolean {
  return /^claude-haiku-\d/.test(claudeReviewIdentity(modelId)) && canSpecifyClaudeReviewModel(modelId);
}

/** A Claude model the CLI refuses to run in Auto mode at all; no reviewer choice changes that. */
export function cliRefusesAutoMode(modelId: string | null | undefined): boolean {
  const id = claudeReviewIdentity(modelId ?? '');
  return /^claude-/.test(id) && !supportedClaude.test(id);
}

/** A Claude model Claude Code runs Auto mode on (whether or not it may also be named as the reviewer). */
export function runsClaudeAutoMode(modelId: string): boolean {
  const id = claudeReviewIdentity(modelId);
  return /^claude-/.test(id) && supportedClaude.test(id);
}

/**
 * "Can review" for Gugu's own catalog: a Claude model the CLI both runs Auto mode on and honours as
 * CLAUDE_CODE_AUTO_MODE_MODEL. Non-Claude models are excluded: a reviewer whose answer the CLI cannot parse
 * makes it block every action ("could not evaluate this action").
 */
export function isAutoReviewCapable(modelId: string): boolean {
  return runsClaudeAutoMode(modelId) && canSpecifyClaudeReviewModel(modelId);
}

/**
 * Claude's native auto reviewer currently accepts Anthropic Messages connections only, and the same rule as
 * Gugu's catalog applies to their models: GLM or DeepSeek served on the Anthropic wire still answer in a form
 * the CLI cannot parse, so they are never offered.
 */
export function autoReviewModelOptions(connections: readonly CustomModelConnection[]) {
  return connections.filter(connection => !connection.removed && connection.keySaved
    && connection.endpoints.some(endpoint => endpoint.protocol === 'anthropic-messages'))
    .flatMap(connection => connection.models.filter(model => isAutoReviewCapable(model.id)).map(model => ({
      connectionId: connection.id, modelId: model.id, label: model.label || model.id, source: connection.name,
    })));
}

export type PlatformReviewCandidate = {
  id: string; displayName?: string; enabled?: boolean;
  protocols?: readonly string[]; requiresMembership?: boolean;
};

/** Every model of Gugu's catalog that can review a Claude session, on the Anthropic wire, for this account. */
export function platformAutoReviewModelOptions(models: readonly PlatformReviewCandidate[]) {
  return models.filter(model => model.enabled !== false && !model.requiresMembership
    && (!model.protocols || model.protocols.includes('anthropic-messages')) && isAutoReviewCapable(model.id))
    .map(model => ({ modelId: model.id, label: model.displayName?.trim() || model.id }));
}
