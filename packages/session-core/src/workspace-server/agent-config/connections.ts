import { z } from 'zod';

/** 一把连接点名的模型:去重、去空,至少一个(没有模型格的家整格不给)。 */
const connectionModelsSchema = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(200)
  .transform((models) => [...new Set(models)]);

/** Device-owned connection metadata. Credential material is deliberately absent. */
export const harnessConnectionSchema = z.object({
  id: z.string(),
  kind: z.enum(['native', 'account', 'api-key']),
  name: z.string(),
  /** API Key 连接的地址;缺席 = 这家的官方地址(用户没改预填的那一个)。 */
  endpoint: z.string().optional(),
  /** API Key 连接点名的模型(只有声明了 `model: 'required'` 的家才有),一个或几个。 */
  models: z.array(z.string()).optional(),
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

/**
 * `stopBusySessions`:被「有会话正在工作」拒过之后，用户点了「关掉并切换」—— 正在工作的也关掉，照切。
 * 删除也用它(#2507):删当前连接 = 一次切换(落回原生),同一道护栏、同一个出路。
 */
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
    /** 该家声明 `model: 'required'` 时至少一个(主进程按声明核),其余家不收。 */
    models: connectionModelsSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'api-key' && !value.apiKey) {
      ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'API key is required' });
    }
    if (value.kind === 'account' && (value.apiKey || value.endpoint || value.models?.length)) {
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

/**
 * 读一个地址自己报的模型清单(`{地址}/models`,#2507)。读在**宿主进程**里做,key 只到那个地址:
 * 表单里还没存的连接带 `apiKey` + `endpoint`(缺席 = 这家的官方地址);已存的连接(「管理模型」)只带 `connectionId`,key 宿主自己解。
 */
export const listConnectionModelsSchema = z
  .object({
    providerId: connectionProviderId,
    connectionId: z.string().min(1).optional(),
    apiKey: z.string().trim().min(1).max(8192).optional(),
    endpoint: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.connectionId === !value.apiKey) {
      ctx.addIssue({ code: 'custom', message: 'Give either a saved connection or a key to read with' });
    }
  });

/**
 * 读到了 ⇒ `listed`;读不到 ⇒ `unlisted` + 一个原因,表单退回手填:
 * `no-list` 这个地址不报模型清单;`unauthorized` 地址拒了这把 key;`unreachable` 连不上这个地址。
 */
export const connectionModelListSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('listed'), models: z.array(z.string()) }),
  z.object({ kind: z.literal('unlisted'), reason: z.enum(['no-list', 'unauthorized', 'unreachable']) }),
]);

/** 「管理模型」:换一把已存连接点名的模型,❌ 删了重加。 */
export const updateConnectionModelsSchema = harnessConnectionTargetSchema.extend({
  models: connectionModelsSchema,
});

export type ListConnectionModels = z.infer<typeof listConnectionModelsSchema>;
export type ConnectionModelList = z.infer<typeof connectionModelListSchema>;
export type UpdateConnectionModels = z.infer<typeof updateConnectionModelsSchema>;
