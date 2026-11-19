import { z } from 'zod';
import type { CustomModelConnection } from './custom-model';

/** An auxiliary preference never grants cross-connection use or changes the conversation model. */
export const autoReviewModelSchema = z.object({
  kind: z.literal('custom'),
  connectionId: z.string().uuid(),
  modelId: z.string().trim().min(1).max(200),
}).nullable();
export type AutoReviewModel = z.infer<typeof autoReviewModelSchema>;

/** Normalize known full provider IDs, never translated labels. */
function claudeReviewIdentity(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').split('/').at(-1)!
    .replace(/^(?:us|eu|apac|global)\./, '').replace(/^anthropic\./, '')
    .replace(/@20\d{6}$/, '').replace(/-v\d+(?::\d+)?$/, '').replace(/-20\d{6}$/, '')
    .replace(/^(opus|sonnet|haiku)-(\d)/, 'claude-$1-$2');
}

/** CLI 2.1.310 Oqo/UB; https://code.claude.com/docs/en/permission-modes#when-your-model-doesnt-review */
export function canSpecifyClaudeReviewModel(modelId: string): boolean {
  const id = claudeReviewIdentity(modelId);
  return !!id && !['default', 'opus', 'sonnet', 'haiku', 'fable',
    'claude-opus-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].includes(id);
}

export function isHaikuReviewModel(modelId: string): boolean {
  return /^claude-haiku-\d/.test(claudeReviewIdentity(modelId)) && canSpecifyClaudeReviewModel(modelId);
}

/** Claude's native auto reviewer currently accepts Anthropic Messages connections only. */
export function autoReviewModelOptions(connections: readonly CustomModelConnection[]) {
  return connections.filter(connection => !connection.removed && connection.keySaved
    && connection.endpoints.some(endpoint => endpoint.protocol === 'anthropic-messages'))
    .flatMap(connection => connection.models.filter(model => canSpecifyClaudeReviewModel(model.id)).map(model => ({
      connectionId: connection.id, modelId: model.id, label: model.label || model.id, source: connection.name,
    })));
}
