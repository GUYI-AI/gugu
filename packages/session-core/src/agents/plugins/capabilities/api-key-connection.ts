import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';
import type { SubscriptionPlanReading, SubscriptionUsageReading } from './subscription';

/**
 * 「API Key 连接」(#2507,owner 2026-11-12):设置 → 订阅里每一家都能存几把 API Key、选一把用,与 Claude / Codex
 * 已有的连接同一个面板。这一格声明**这一家的进程怎么吃一把 key**:表单要哪几格、地址得讲哪种接口,
 * 以及 behavior 里的 `launch` —— 一把 key 落成哪几个环境变量 / 参数。
 *
 * 选中的连接在**每次起进程时**由宿主解密、经 `launch` 叠进环境(低于平台注入,见 `composeAgentSpawnEnv`);
 * key 不落盘、不进 renderer。会话跟着默认连接走。
 *
 * ⚠️ 只管 API Key。账号连接(多个账号、换凭据)仍只有 Claude / Codex(它们换凭据的代码逐家写),那两家
 *    也不在这里声明 —— 它们的连接仍走自己那条路。其余家的「账号」= 这家 CLI 自己的登录(`auth`)。
 * ⚠️ 没声明 = 这家没有经核实的「一把 key 怎么进进程」,表单里不出 API Key。❌ 凭「它读 OPENAI_API_KEY」猜。
 */
const apiKeyConnectionProtocolSchema = z.enum([
  'anthropic-messages',
  'openai-responses',
  'openai-chat-completions',
  'gemini-generate-content',
]);
export type ApiKeyConnectionProtocol = z.infer<typeof apiKeyConnectionProtocolSchema>;

export const apiKeyConnectionDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z
    .object({
      kind: z.literal('supported'),
      /**
       * 地址(owner 2026-11-12:「地址 + Key 是主体,官方和中转一视同仁,官方也只是一个地址」):
       * `none` = 只认官方 key、没有地址格;`optional` = 不给地址这家也跑官方;`required` = 这家离了地址起不来。
       */
      endpoint: z.enum(['none', 'optional', 'required']),
      /**
       * 官方地址:表单里地址格**一开始就填好的值**(「不要让用户填默认地址」)。用户没改它 = 官方 ——
       * 存的时候不记地址,付款方、连接上那一行、用量处处读作「官方」(见 `apiKeyConnectionEndpoint`)。
       * 缺席 = 这家没有一个拿这把 key 就能用的官方地址(地址格空着让人填)。
       */
      officialEndpoint: z.string().url().optional(),
      /** 模型:`required` = 这家必须点名模型才起得来;一把连接可以点名好几个(新建任务的模型菜单里都在)。 */
      model: z.enum(['none', 'required']),
      /** 地址讲的接口。有地址就必须写;`protocols` 有好几种时,它是探不出来时用的那一种。 */
      protocol: apiKeyConnectionProtocolSchema.optional(),
      /**
       * 这家的写法讲得了的全部接口(pi 的 `api`、opencode 的 provider 包都能在 Responses 与 Chat Completions 之间换)。
       * 多于一种 ⇒ 宿主建连接时按地址探一次(不花 token)选一种;缺席 = 只讲 `protocol` 那一种。
       */
      protocols: z.array(apiKeyConnectionProtocolSchema).min(1).optional(),
      /**
       * 这把 key 怎么进进程:
       * - `env`(缺省):behavior 的 `launch` 把它落成环境变量 / 参数,叠在平台注入之下。
       * - `model-injection`:这家只能经**配置文件 / 配置文档**认一个自定义地址(pi 的 `models.json`、opencode 的
       *   `OPENCODE_CONFIG_CONTENT`、CodeBuddy 的 `--settings`),环境变量够不着。宿主像平台会话那样造一份模型声明,
       *   只是地址、key、模型都来自连接,再交给这家已有的平台模型写法(`sessionBundle.platformModel`)落盘 ——
       *   同一条测过的注入,❌ 另写一套。⚠️ 它**不是**平台会话:不签咕咕令牌、不扣积分、不进账本。
       *   所以地址与模型必填,协议 = 这家平台声明的 `wireProtocol`(注册时核);不要 behavior。
       */
      delivery: z.enum(['env', 'model-injection']).optional(),
      /** 实测 / 源码出处,一句话。 */
      evidence: z.string().min(1),
    })
    .superRefine((value, ctx) => {
      if (value.endpoint !== 'none' && !value.protocol) {
        ctx.addIssue({ code: 'custom', path: ['protocol'], message: 'An endpoint needs the protocol it must speak' });
      }
      if (value.endpoint === 'none' && value.officialEndpoint) {
        ctx.addIssue({ code: 'custom', path: ['officialEndpoint'], message: 'An agent without an address field has no address to prefill' });
      }
      if (value.protocols && (!value.protocol || !value.protocols.includes(value.protocol))) {
        ctx.addIssue({ code: 'custom', path: ['protocols'], message: 'The fallback protocol must be one of the protocols this agent speaks' });
      }
      if (value.delivery === 'model-injection' && (value.endpoint !== 'required' || value.model !== 'required')) {
        ctx.addIssue({
          code: 'custom',
          path: ['delivery'],
          message: 'A model-injection connection names its own endpoint and model: both must be required',
        });
      }
    }),
]);

export type ApiKeyConnectionDescriptor = z.infer<typeof apiKeyConnectionDescriptorSchema>;
export type ApiKeyConnectionFields = Extract<ApiKeyConnectionDescriptor, { kind: 'supported' }>;

export type ApiKeyConnectionInput = {
  apiKey: string;
  /** 这次要用的地址(用户没改官方地址时,宿主递的是官方地址);缺席 = 这家自己的默认。 */
  endpoint?: string;
  /** 这次会话跑的那一个模型(连接点名的几个里,会话选中的那个)。 */
  model?: string;
};

export type ApiKeyConnectionLaunch = {
  /** 这把 key 落成的环境变量(叠在用户 env 之上、平台注入之下)。 */
  env: Record<string, string>;
  /** 先删掉的继承变量:用户 shell 里 export 的同族凭据不能顶掉所选的连接。 */
  unsetEnv: readonly string[];
  /** 追加的 CLI 参数(只到得了终端腿;ACP 腿递不进 argv 的家别靠它)。 */
  args?: readonly string[];
};

export type IApiKeyConnectionBehavior = {
  /** 纯函数:同样的输入恒得同样的输出,❌ 读环境、读盘。 */
  launch(input: ApiKeyConnectionInput): ApiKeyConnectionLaunch;
};

/**
 * Claude / Codex 的 API 连接的官方地址(它们不在这一格声明,连接走自己那条路):表单地址格预填它,
 * 宿主照它判「官方」。Codex 的地址带 `/v1`(它的 provider `base_url` 就这么写),Claude 是裸根。
 */
export const ACCOUNT_PROVIDER_OFFICIAL_ENDPOINTS: Readonly<Record<string, string>> = {
  claude: 'https://api.anthropic.com',
  codex: 'https://api.openai.com/v1',
};

/** OpenAI 的官方地址:讲 OpenAI 接口(Responses / Chat Completions)的家,地址格预填它。 */
export const OPENAI_OFFICIAL_ENDPOINT = 'https://api.openai.com/v1';

/** 这一家的 API Key 经宿主造的模型声明进进程(见 `delivery`)。 */
export function apiKeyConnectionInjectsModel(descriptor: ApiKeyConnectionDescriptor | undefined): boolean {
  return descriptor?.kind === 'supported' && descriptor.delivery === 'model-injection';
}

export const apiKeyConnectionCapability = definePluginCapability<IApiKeyConnectionBehavior>()(
  'apiKeyConnection',
  apiKeyConnectionDescriptorSchema,
  { kind: 'none' },
  // 走模型注入的家没有自己的 `launch`:那条路的写法就是它的平台模型写法。
  { requiresBehavior: (descriptor) => descriptor.kind === 'supported' && descriptor.delivery !== 'model-injection' }
);

/**
 * 按这一家的声明核对一份「新建 API Key 连接」的输入:该有的格有、不该有的格没有。返回第一条错,全对返回 null。
 * 宿主(主进程)在存之前调它;renderer 的表单只是同一份声明的投影,❌ 当作校验。
 */
export function apiKeyConnectionInputError(
  fields: Pick<ApiKeyConnectionFields, 'endpoint' | 'model'>,
  input: { endpoint?: string; models?: readonly string[] }
): string | null {
  if (fields.endpoint === 'none' && input.endpoint) return 'This agent only takes its official API key; it has no address field';
  if (fields.endpoint === 'required' && !input.endpoint) return 'An API address is required';
  if (fields.model === 'none' && input.models?.length) return 'This agent takes no model with its API key';
  if (fields.model === 'required' && !input.models?.length) return 'Pick at least one model';
  return null;
}

/** 地址比较:去掉结尾的 `/`,协议与主机不分大小写(`https://API.openai.com/v1/` 就是官方那一个)。 */
function sameEndpoint(a: string, b: string): boolean {
  const normal = (value: string) => {
    const trimmed = value.trim().replace(/\/+$/, '');
    try {
      const url = new URL(trimmed);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  };
  return normal(a) === normal(b);
}

/**
 * 一把连接**记下来**的地址:空着、或就是这家的官方地址 ⇒ 不记(undefined = 官方)。
 * 「官方」于是只有一种写法,付款方、连接那一行、用量都照「没有地址」读作官方,❌ 读成「自定义服务」。
 * 读旧数据时也过一遍:修改前存进去的官方地址照样读作官方。
 */
export function apiKeyConnectionEndpoint(
  fields: Pick<ApiKeyConnectionFields, 'officialEndpoint'>,
  endpoint: string | undefined
): string | undefined {
  const value = endpoint?.trim().replace(/\/+$/, '');
  if (!value) return undefined;
  if (fields.officialEndpoint && sameEndpoint(value, fields.officialEndpoint)) return undefined;
  return value;
}

/** 选中的是 API Key 连接时「订阅」那一格的读数:谁付钱一目了然,❌ 去读 CLI 自己的文件说「未登录」。 */
export function apiKeyConnectionPlan(endpoint: string | undefined): SubscriptionPlanReading {
  if (!endpoint) return { payer: 'api-key' };
  let host: string;
  try {
    host = new URL(endpoint).host;
  } catch {
    host = endpoint;
  }
  return { payer: 'custom-endpoint', endpoint: host };
}

/** 同上,用量:API Key 的余量只在厂商后台(自定义地址:那台服务自己知道)。 */
export function apiKeyConnectionUsage(endpoint: string | undefined): SubscriptionUsageReading {
  return { kind: 'unavailable', reason: endpoint ? 'custom-endpoint' : 'not-reported', readAt: Date.now() };
}
