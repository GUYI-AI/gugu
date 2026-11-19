import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';
import { copilotOwnLogin } from './subscription';

export const COPILOT_LOGIN_METHOD_ID = 'copilot-login';

/** Copilot 认令牌的先后(厂商文档 authenticate-copilot-cli):这三个环境变量排在它自己的登录前面。 */
const TOKEN_ENVS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;
/** 自带模型(BYOK):三件套齐了就不要 GitHub 账号;缺模型它直接退出「BYOK providers require an explicit model」。 */
const BYOK_ENVS = ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_MODEL'] as const;
const GH_TIMEOUT_MS = 10_000;

const present = (ctx: AgentAuthContext, name: string) => Boolean(ctx.env?.[name]?.trim());

/**
 * #2507 Copilot 登没登,照它自己选凭据的先后判(1.0.109 隔离环境实测):
 *  1. 环境变量里的 GitHub 令牌 → 已登录;
 *  2. 自带模型三件套齐 → 已登录(按 Key 计);
 *  3. 它自己 `copilot login` 存在钥匙串里的那一项(只看在不在,不读内容、不弹授权框)→ 已登录;
 *  4. 退到 `gh` 的登录:`gh auth status` 通过 → 已登录。
 * 钥匙串查询本身失败、或者不是 macOS(别处它把登录存在哪没有一手读数)→ 判不出,❌ 当成没登录。
 */
export async function copilotAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  if (TOKEN_ENVS.some((name) => present(ctx, name))) return { kind: 'authenticated', credentialKind: 'subscription' };
  if (BYOK_ENVS.every((name) => present(ctx, name))) return { kind: 'authenticated', credentialKind: 'api-key' };
  const own = await copilotOwnLogin(ctx);
  if (own === 'present') return { kind: 'authenticated', credentialKind: 'subscription' };
  if (await ghSignedIn(ctx)) return { kind: 'authenticated', credentialKind: 'subscription' };
  if (own === 'unknown' || process.platform !== 'darwin') {
    return { kind: 'unknown', message: 'Copilot 的登录存在系统钥匙串里,这里查不到它在不在。' };
  }
  return { kind: 'unauthenticated' };
}

async function ghSignedIn(ctx: AgentAuthContext): Promise<boolean> {
  try {
    await ctx.exec('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: GH_TIMEOUT_MS });
    return true;
  } catch {
    // 没装 gh、没登录、超时都一样:gh 这条退路不成立。
    return false;
  }
}
