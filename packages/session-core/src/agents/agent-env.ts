/**
 * 用户 shell 里透传给 agent 的、**多家共用**的变量名:厂商 SDK 的通用约定(`OPENAI_*`、`ANTHROPIC_API_KEY`、
 * `AWS_*` 走 Bedrock、`GOOGLE_*` 走 Vertex/ADC、各家聚合平台的 key)与咕咕自己的测试开关。
 * **某一家自己的**名字(品牌前缀、它的数据根、它的模型旋钮)由那一家插件的 `sessionBundle.shellEnv.passThrough` 声明;
 * 宿主用的白名单是这两份的并集(session-plugins `agentShellEnvPassThrough`)。
 * `APP_SERVER_LOGS` 查不到是哪一家读的(历史遗留),照旧放这里。
 */
export const SHARED_AGENT_ENV_VARS = [
  'AIMLAPI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'APP_SERVER_LOGS',
  'AWS_ACCESS_KEY_ID',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_OPENAI_API_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_KEY',
  'DASHSCOPE_API_KEY',
  'GEMINI_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GUGU_SESSION_TEST_HOOKS',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENAI_API_VERSION',
  'GOOGLE_VERTEX_BASE_URL',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'XAI_API_KEY',
  'ZAI_API_KEY',
] as const;

/**
 * 用户 shell 里**明确不许**透传给 agent 的变量 —— 咕咕自己管着的那几格(#5873)。
 *
 * 会话 env 有一层**底座**(`buildUserShellBaseEnv`:用户登录环境默认全过,只挡负名单),所以拒绝必须写下来,
 * 不写就是从后门放进来。这里只放与哪一家都无关的;**某一家的**(claude 的信任通道、codex 的令牌、opencode 的配置根)
 * 由那一家插件的 `sessionBundle.shellEnv.denied` 声明,宿主取并集(session-plugins `agentShellEnvDenied`)。
 *
 *  · `NODE_TLS_REJECT_UNAUTHORIZED` —— 关掉 TLS 校验。用户 shell 里为了调试留下的一个 `0`
 *    不该静默地传染给每一条 agent 会话。
 *  · `TOOLBOX_ACTION` —— 厂商自己的工具箱集成开关,与本会话无关。
 *    (2026-09-21 #6097:同组的 `GOOSE_TERMINAL` 随 goose 插件一起删掉。)
 */
export const HOST_SHELL_DENIED_ENV_VARS = [
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'TOOLBOX_ACTION',
] as const;

export const TRANSPORT_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const;

/**
 * 咕咕自己的服务都在本机回环上:推理网关(平台模型中转)、咕咕 MCP、集成转发口、扩展网关、hook。
 * agent 发给它们的请求**永远不能交给代理**。
 *
 * 实测(2026-11-16 mbp,Clash Verge Rev 全局模式,用户 ~/.zshrc 里有 Clash「复制环境变量」那一套、没有 NO_PROXY):
 * claude 把发往 127.0.0.1 推理网关的请求交给了 Clash(Clash 日志 44 条 `--> 127.0.0.1:51570 using GLOBAL`),
 * Clash 把它送去远端节点,每一轮都是 502。规则模式下 Clash 恰好把 127/8 判成直连,问题被盖住了。
 *
 * 所以**无条件**并进去,不看这份环境里有没有代理变量:有的 harness 不读环境变量,
 * 读的是系统代理(macOS 的 scutil、Windows 的 Internet 设置),环境里一个代理变量都没有也照样会走代理。
 * 多带一条回环豁免没有代价;少带一条,会话在某些用户的机器上就跑不通。
 * 合并而不是覆盖:用户自己的条目一条不丢;大小写两份写成同一个值,各家读哪一份都一样。
 */
export const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

export function withLoopbackNoProxy<T extends Record<string, string | undefined>>(env: T): T & { NO_PROXY: string; no_proxy: string } {
  const entries = [env.NO_PROXY, env.no_proxy]
    .flatMap((value) => (value ?? '').split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const value = [...new Set([...entries, ...LOOPBACK_NO_PROXY_HOSTS])].join(',');
  return { ...env, NO_PROXY: value, no_proxy: value };
}
