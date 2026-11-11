import type { AcpAgentApi, ApiKeyConnectionDescriptor, IAcpBehavior, IApiKeyConnectionBehavior } from '@gugu/session-core/agents/plugins';

/**
 * Antigravity(#2507):`agy_acp_server` 的「自定义 AI API 网关」认证方式 —— **按进程**选、**从不落盘**。
 *
 * 为什么不是 `gemini-api-key`:那条要么靠 settings.json 的 `auth.type`,要么靠 ACP `authenticate`,而后者把
 * `auth.type` **写进** `$GEMINI_HOME/antigravity-acp/settings.json`。咕咕的 GEMINI_HOME 是一份托管根、Google
 * 账号登录也用它 ⇒ 一条连接会话就把账号登录的选择改掉(实测 2026-11-12)。
 *
 * 网关那条(1.4.5 源码 `gateway/resolution.py`、`server.py authenticate`):
 *  · 宿主经 `launch` 给值:`AGY_LLM_GATEWAY_URL` / `_API_KEY`(它自己转成 `Authorization: Bearer`)/ `_MODELS`
 *    (这条会话的模型目录 = 连接点名的那一个)。环境只给值、不选方式。
 *  · 选方式是 ACP `authenticate {methodId:'gateway'}`:那一支「per-connection and never persisted」,跳过
 *    `_remember_auth_type` —— settings.json 一个字不动(实测跑前跑后同一个哈希)。
 *  · `AGY_ACP_ENABLE_GATEWAY_AUTH` 是它的上线开关(「contract is not yet ratified」):不开,方法既不报也不收。
 *    只有带着连接起的进程才有这个开关 ⇒ agy 在 `initialize` 里报出 `gateway` = 这条进程是连接会话。
 * 协议:请求是 genai 形状(`POST {地址}/v1beta/models/{模型}:streamGenerateContent`),`x-goog-api-key` 恒为
 * 它的占位值 `dummy_api_key`,真 key 只在 Bearer 里。
 */
export const ANTIGRAVITY_GATEWAY_METHOD = 'gateway';

/** 「报了才认」的那份声明(`acp.authenticateWhenAdvertised`):会话的 `connect` 与模型目录探针读同一份。 */
export const ANTIGRAVITY_GATEWAY_AUTH = {
  methodId: ANTIGRAVITY_GATEWAY_METHOD,
  clientAuthMeta: { gateway: true },
} as const satisfies NonNullable<IAcpBehavior['authenticateWhenAdvertised']>;

export const antigravityApiKeyConnection = {
  kind: 'supported',
  endpoint: 'required',
  model: 'required',
  protocol: 'gemini-generate-content',
  evidence:
    '2026-11-12 MBP agy_acp_server 1.4.5(隔离 HOME / GEMINI_HOME,no-browser):launch 的四个 AGY_* 值 + ACP authenticate(gateway),'
    + '三轮 POST /v1beta/models/<连接的模型>:streamGenerateContent、Bearer 是连接的 key;共享 settings.json 跑前跑后同一个 sha256',
} as const satisfies ApiKeyConnectionDescriptor;

/** 它读的网关那一族(含旧名):先删掉,shell 里漏进来的同族变量顶不掉所选的连接。 */
export const ANTIGRAVITY_CONNECTION_UNSET_ENV = [
  'AGY_ACP_ENABLE_GATEWAY_AUTH',
  'AGY_LLM_GATEWAY_URL',
  'AGY_LLM_GATEWAY_API_KEY',
  'AGY_LLM_GATEWAY_HEADERS',
  'AGY_LLM_GATEWAY_MODELS',
  'AGY_LLM_GATEWAY_CA_CERT',
  'AGY_LLM_GATEWAY_PROXY_URL',
  'AGY_GATEWAY_URL',
  'AGY_GATEWAY_API_KEY',
  'AGY_GATEWAY_HEADERS',
] as const;

export const antigravityApiKeyConnectionBehavior: IApiKeyConnectionBehavior = {
  launch: ({ apiKey, endpoint, model }) => {
    if (!endpoint || !model) throw new Error('Antigravity needs an API address and a model with its API key');
    return {
      env: {
        AGY_ACP_ENABLE_GATEWAY_AUTH: '1',
        AGY_LLM_GATEWAY_URL: endpoint,
        AGY_LLM_GATEWAY_API_KEY: apiKey,
        AGY_LLM_GATEWAY_MODELS: model,
      },
      unsetEnv: ANTIGRAVITY_CONNECTION_UNSET_ENV,
    };
  },
};

const OPENS_A_SESSION: ReadonlySet<PropertyKey> = new Set(['newSession', 'loadSession', 'resumeSession', 'unstable_forkSession']);

type Authenticating = { authenticate?(params: { methodId: string }): Promise<unknown> };

/**
 * 连接会话在开第一条会话之前选网关(每个进程一次);别的会话一个请求都不多发。
 *
 * 判据是 agy 自己的 `initialize` 应答:它只在上线开关开着(= 这条进程带着连接起)且客户端声明了
 * `auth._meta.gateway` 时才报 `gateway`。所以这里总是声明,只在它报了的时候才 `authenticate` ——
 * Google 账号会话的开关是关的,它不报,后面的请求原样过。
 */
export function withGatewayAuthentication(api: AcpAgentApi): AcpAgentApi {
  let advertised = false;
  let signedIn: Promise<unknown> | null = null;
  const signIn = (): Promise<unknown> => {
    signedIn ??= (async () => {
      const authenticate = (api as AcpAgentApi & Authenticating).authenticate;
      if (!authenticate) throw new Error('Antigravity advertised the gateway auth method but this ACP connection cannot authenticate');
      return authenticate.call(api, { methodId: ANTIGRAVITY_GATEWAY_AUTH.methodId });
    })();
    return signedIn;
  };
  return new Proxy(api, {
    get(target, property) {
      if (property === 'initialize') {
        return async (params: Parameters<AcpAgentApi['initialize']>[0]) => {
          const capabilities = params.clientCapabilities;
          const response = await target.initialize({
            ...params,
            clientCapabilities: {
              ...capabilities,
              auth: { ...capabilities?.auth, _meta: { ...capabilities?.auth?._meta, ...ANTIGRAVITY_GATEWAY_AUTH.clientAuthMeta } },
            },
          });
          advertised = (response.authMethods ?? []).some((method) => method.id === ANTIGRAVITY_GATEWAY_AUTH.methodId);
          return response;
        };
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (!OPENS_A_SESSION.has(property)) return value.bind(target);
      return async (...args: unknown[]) => {
        if (advertised) await signIn();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
