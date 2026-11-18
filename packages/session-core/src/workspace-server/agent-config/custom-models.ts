import { z } from 'zod';
import { customModelConnectionSchema, customModelMetaSchema, modelEndpointSchema } from '../../models/custom-model';

export { customModelConnectionSchema };

export const saveCustomModelSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  ...customModelMetaSchema.omit({ removed: true }).shape,
}).refine(({ models }) => models.length > 0, 'Pick at least one model');
export type SaveCustomModel = z.infer<typeof saveCustomModelSchema>;

export const testCustomModelSchema = z.object({
  connectionId: z.string().min(1).optional(),
  apiKey: z.string().trim().min(1).max(8192).optional(),
  endpoints: z.array(modelEndpointSchema).min(1).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
}).refine(({ connectionId, apiKey, endpoints }) => connectionId || (apiKey && endpoints), 'Choose a saved connection or supply its address and key');
export type TestCustomModel = z.infer<typeof testCustomModelSchema>;
