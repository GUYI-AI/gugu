import type { AgentAuthContext, AgentAuthStatus } from '@gugu/session-core/agents/plugins';
import { readHermesPlan } from './subscription';

export const HERMES_LOGIN_METHOD_ID = 'hermes-nous-login';

/**
 * 不登录也能用的 Key:Hermes 按凭据自动挑供应商时,这些环境变量排在 `auth.json` 前面
 * (NousResearch/hermes-agent `website/docs/reference/environment-variables.md`;
 * 自定义地址 = `OPENAI_API_KEY` + `OPENAI_BASE_URL`)。
 */
const KEY_ENVS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'] as const;

/**
 * #2507 Hermes 登没登 = 它手上有没有能用的凭据。与「订阅」页同一份读数(`readHermesPlan` 读
 * `$HERMES_HOME/config.yaml` 的 `model:` 块与 `auth.json`),只把它折成三态:
 *  · 读数说「没接任何一家」且环境变量里也没有 Key → 没登录;
 *  · 读不出 / 判不出接哪家 → 判不出(❌ 当成没登录);
 *  · 其余(订阅、Key、自定义地址)→ 已登录。
 */
export async function hermesAuthStatus(ctx: AgentAuthContext): Promise<AgentAuthStatus> {
  if (KEY_ENVS.some((name) => ctx.env?.[name]?.trim())) return { kind: 'authenticated', credentialKind: 'api-key' };
  const plan = await readHermesPlan(ctx);
  switch (plan.payer) {
    case 'not-signed-in':
      return { kind: 'unauthenticated' };
    case 'unknown':
      return { kind: 'unknown', ...(plan.message ? { message: plan.message } : {}) };
    case 'subscription':
      return { kind: 'authenticated', credentialKind: 'subscription' };
    default:
      return { kind: 'authenticated', credentialKind: 'api-key' };
  }
}
