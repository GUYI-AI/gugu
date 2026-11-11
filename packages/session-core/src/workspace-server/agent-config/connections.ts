import { z } from 'zod';

/** Device-owned connection metadata. Credential material is deliberately absent. */
export const harnessConnectionSchema = z.object({
  id: z.string(),
  kind: z.enum(['native', 'account', 'api-key']),
  name: z.string(),
  endpoint: z.string().optional(),
  /** API Key 连接点名的模型(只有声明了 `model: 'required'` 的家才有)。 */
  model: z.string().optional(),
  current: z.boolean(),
});

/**
 * 哪一家。合同只收一个非空 id:**哪些家能有连接**由主进程按插件注册表判(Claude / Codex 有账号连接;
 * 声明了 `apiKeyConnection` 的家有 API Key 连接;其余一律拒),❌ 在合同里写死名单。
 */
const connectionProviderId = z.string().trim().min(1).max(64);

export const harnessConnectionTargetSchema = z.object({
  providerId: connectionProviderId,
  connectionId: z.string().min(1),
});

/** `stopBusySessions`:被「有会话正在工作」拒过之后，用户点了「关掉并切换」—— 正在工作的也关掉，照切。 */
export const harnessConnectionSelectSchema = harnessConnectionTargetSchema.extend({
  stopBusySessions: z.boolean().optional(),
});

export const createHarnessConnectionSchema = z
  .object({
    providerId: connectionProviderId,
    kind: z.enum(['account', 'api-key']),
    name: z.string().trim().max(80).optional(),
    apiKey: z.string().trim().min(1).max(8192).optional(),
    endpoint: z.string().url().optional(),
    /** 该家声明 `model: 'required'` 时必填(主进程按声明核),其余家不收。 */
    model: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'api-key' && !value.apiKey) {
      ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'API key is required' });
    }
    if (value.kind === 'account' && (value.apiKey || value.endpoint || value.model)) {
      ctx.addIssue({ code: 'custom', message: 'Account sign-in cannot include API credentials' });
    }
    if (value.endpoint) {
      const url = new URL(value.endpoint);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['endpoint'],
          message: 'Use an HTTP(S) endpoint without credentials, query or fragment',
        });
      }
    }
  });

export type HarnessConnection = z.infer<typeof harnessConnectionSchema>;
export type CreateHarnessConnection = z.infer<typeof createHarnessConnectionSchema>;
