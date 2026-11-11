import type { ApiKeyConnectionDescriptor, IApiKeyConnectionBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';
import { hermesPlatformEnv } from './session-bundle';

/**
 * Hermes(#2507):咕咕经 `hermes serve` + 桥驱动它,桥从**自己的进程环境**读 `GUGU_HERMES_PLATFORM_*`,把地址、
 * key、模型写进 serve 的托管配置(具名 provider,`api_key: ${GUGU_HERMES_PLATFORM_KEY}`,值只在 serve 的环境里;
 * 用户 `HERMES_HOME` 一个字不碰)。所以一把连接 = 同一组桥输入,由平台那份写法 `hermesPlatformEnv` 造 —— ❌ 另写变量名。
 *
 * 平台会话:信封注入器把**同样这几个键**整份压在上面(宿主注入层)⇒ 两份不会在一个桥里拼起来。
 * 协议 = 平台那份写法的 `transport`(./platform.ts 的 `HERMES_TRANSPORT`)。
 */
export const hermesApiKeyConnection = {
  kind: 'supported',
  endpoint: 'required',
  model: 'required',
  protocol: harnessPlatform.wireProtocol,
  evidence:
    '2026-11-12 MBP hermes 2026.9.24(b5f15a6d,隔离 venv + HERMES_HOME):只把 launch 的四个桥输入给 hermes-serve-acp,'
    + 'serve 托管层的具名 provider 打 POST /v1/responses、Bearer 是连接的 key,一轮回话',
} as const satisfies ApiKeyConnectionDescriptor;

/** 桥的那几个输入:先删掉,shell 里漏进来的同名变量顶不掉所选的连接。 */
export const HERMES_CONNECTION_UNSET_ENV = [
  'GUGU_HERMES_PLATFORM_BASE_URL',
  'GUGU_HERMES_PLATFORM_KEY',
  'GUGU_HERMES_PLATFORM_MODEL',
  'GUGU_PLATFORM_MODELS',
] as const;

export const hermesApiKeyConnectionBehavior: IApiKeyConnectionBehavior = {
  launch: ({ apiKey, endpoint, model }) => {
    if (!endpoint || !model) throw new Error('Hermes needs an API address and a model with its API key');
    return {
      env: hermesPlatformEnv({ dialect: harnessPlatform.dialect, model, platformProvider: { baseUrl: endpoint, apiKey } }),
      unsetEnv: HERMES_CONNECTION_UNSET_ENV,
    };
  },
};
