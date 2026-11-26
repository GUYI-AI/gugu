import { z } from 'zod';
import { connectionUnlistedReasonSchema } from './connections';
import { customModelConnectionSchema, customModelMetaSchema, modelEndpointSchema, modelProtocolSchema } from '../../models/custom-model';

export { customModelConnectionSchema };

export const saveCustomModelSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  resolveUrlConflict: z.boolean().optional(),
  ...customModelMetaSchema.omit({ removed: true }).shape,
}).refine(({ id, models, resolveUrlConflict, disabledModels }) => models.length > 0 || Boolean(id && (resolveUrlConflict || disabledModels?.length)), 'Pick at least one model');
export type SaveCustomModel = z.infer<typeof saveCustomModelSchema>;

export const testCustomModelSchema = z.object({
  connectionId: z.string().min(1).optional(),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  endpoints: z.array(modelEndpointSchema).min(1).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
}).refine(({ connectionId, apiKey, endpoints }) => connectionId || (apiKey && endpoints), 'Choose a saved connection or supply its address and key');
export type TestCustomModel = z.infer<typeof testCustomModelSchema>;

/** An address, probed for the protocols it really answers with a typed key or the key a saved connection holds. */
export const detectCustomModelProtocolsSchema = z.object({
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  connectionId: z.string().min(1).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
}).refine(({ apiKey, connectionId }) => apiKey || connectionId, 'Supply a key or a saved connection');
export type DetectCustomModelProtocols = z.infer<typeof detectCustomModelProtocolsSchema>;

export const customModelProtocolProbeSchema = z.object({
  /** Every protocol that answered, with the base URL that answered it. Empty when none did. */
  endpoints: z.array(modelEndpointSchema),
  /** Models the address lists, when it lists any. */
  models: z.array(z.string()),
  /** What each step that failed reported, in the order tried. */
  failures: z.array(z.object({
    step: z.union([z.literal('models'), modelProtocolSchema]),
    reason: z.enum([...connectionUnlistedReasonSchema.options, 'no-model', 'refused']),
  })),
  /**
   * The protocols whose request the address refused for the key (401/403), each with the base URL that refused it, in the
   * order tried: the path exists, only the key was not accepted. "Add anyway" saves the first; absent when none was.
   */
  refused: z.array(modelEndpointSchema).optional(),
});
export type CustomModelProtocolProbe = z.infer<typeof customModelProtocolProbeSchema>;
