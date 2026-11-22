import { z } from 'zod';

/** Device-owned connection metadata. Credential material is deliberately absent. */
export const harnessConnectionSchema = z.object({
  id: z.string(),
  kind: z.enum(['native', 'account']),
  name: z.string(),
  current: z.boolean(),
});

const connectionProviderId = z.string().trim().min(1).max(64);

export const harnessConnectionTargetSchema = z.object({
  providerId: connectionProviderId,
  connectionId: z.string().min(1),
});

/**
 * `stopBusySessions`:被「有会话正在工作」拒过之后，用户点了「关掉并切换」—— 正在工作的也关掉，照切。
 * 删除也用它(#2507):删当前连接 = 一次切换(落回原生),同一道护栏、同一个出路。
 */
export const harnessConnectionSelectSchema = harnessConnectionTargetSchema.extend({
  stopBusySessions: z.boolean().optional(),
});

/** Accounts only. Vendor-key accounts accept a key, as declared by the harness auth capability. */
export const createHarnessConnectionSchema = z.object({
  providerId: connectionProviderId,
  kind: z.literal('account'),
  name: z.string().trim().max(80).optional(),
  apiKey: z.string().trim().min(1).max(8192).optional(),
});

export const renameHarnessConnectionSchema = harnessConnectionTargetSchema.extend({
  name: z.string().trim().min(1).max(80),
});
export type RenameHarnessConnection = z.infer<typeof renameHarnessConnectionSchema>;

export type HarnessConnection = z.infer<typeof harnessConnectionSchema>;
export type CreateHarnessConnection = z.infer<typeof createHarnessConnectionSchema>;

/** Safe, localized transport diagnostics. Never carry exception text or credentials over RPC. */
export const connectionFailureReasonSchema = z.enum([
  'unreachable', 'dns', 'timeout', 'certificate', 'connection-refused', 'redirect', 'proxy',
]);
export type ConnectionFailureReason = z.infer<typeof connectionFailureReasonSchema>;
export const connectionUnlistedReasonSchema = z.enum(['no-list', 'unauthorized', ...connectionFailureReasonSchema.options]);

/**
 * 读到了 ⇒ `listed`; 点名模型试通 ⇒ `connected`; 读不到 ⇒ `unlisted` + 一个原因,表单退回手填:
 * `no-list` 这个地址不报模型清单;`unauthorized` 地址拒了这把 key;`unreachable` 连不上这个地址。
 */
export const connectionModelListSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('listed'), models: z.array(z.string()) }),
  z.object({ kind: z.literal('connected') }),
  z.object({ kind: z.literal('unlisted'), reason: connectionUnlistedReasonSchema }),
]);

export type ConnectionModelList = z.infer<typeof connectionModelListSchema>;
