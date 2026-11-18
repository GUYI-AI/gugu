import { z } from 'zod';
import type { CustomModelConnection } from './custom-model';

/** An auxiliary preference never grants cross-connection use or changes the conversation model. */
export const autoReviewModelSchema = z.object({
  kind: z.literal('custom'),
  connectionId: z.string().uuid(),
  modelId: z.string().trim().min(1).max(200),
}).nullable();
export type AutoReviewModel = z.infer<typeof autoReviewModelSchema>;

/** Claude's native auto reviewer currently accepts Anthropic Messages connections only. */
export function autoReviewModelOptions(connections: readonly CustomModelConnection[]) {
  return connections.filter(connection => !connection.removed && connection.keySaved
    && connection.endpoints.some(endpoint => endpoint.protocol === 'anthropic-messages'))
    .flatMap(connection => connection.models.filter(model => model.id.trim()).map(model => ({
      connectionId: connection.id, modelId: model.id, label: model.label || model.id, source: connection.name,
    })));
}
