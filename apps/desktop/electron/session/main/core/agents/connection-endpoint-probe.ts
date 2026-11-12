import type { ApiKeyConnectionProtocol } from '@gugu/session-core/agents/plugins';
import type { ConnectionModelList } from '@gugu/session-core/workspace-server/agent-config';

/**
 * 读一个 API 地址两件事(#2507,owner 2026-11-12「地址 + Key 是主体」):它报哪些模型、它讲哪种 OpenAI 接口。
 * 只在**宿主进程**里做,key 只发给这个地址本身(`Authorization: Bearer`),❌ 经过任何别的地方。
 */

const PROBE_TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

function url(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, '')}${path}`;
}

/**
 * `{地址}/models`(OpenAI 面的 `GET /v1/models`:`{ data: [{ id }] }`)。别的接口的家(Anthropic / Gemini)
 * 列模型的写法各不相同,这里不猜 ⇒ `no-list`,表单退回手填。
 */
export async function listEndpointModels(
  input: { endpoint: string; apiKey: string; protocol: ApiKeyConnectionProtocol | undefined },
  fetchImpl: Fetch = fetch
): Promise<ConnectionModelList> {
  if (input.protocol !== 'openai-responses' && input.protocol !== 'openai-chat-completions') {
    return { kind: 'unlisted', reason: 'no-list' };
  }
  let response: Response;
  try {
    response = await fetchImpl(url(input.endpoint, '/models'), {
      headers: { authorization: `Bearer ${input.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unlisted', reason: 'unreachable' };
  }
  if (response.status === 401 || response.status === 403) return { kind: 'unlisted', reason: 'unauthorized' };
  if (!response.ok) return { kind: 'unlisted', reason: 'no-list' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'unlisted', reason: 'no-list' };
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { kind: 'unlisted', reason: 'no-list' };
  const models = [
    ...new Set(
      data
        .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim())
    ),
  ].sort((a, b) => a.localeCompare(b));
  return models.length > 0 ? { kind: 'listed', models } : { kind: 'unlisted', reason: 'no-list' };
}

/**
 * 这个地址有没有某个接口 —— 发一个**空请求体**的 POST,不点名模型、上游一个 token 都不花:
 * 接口在 ⇒ 校验请求体时就拒(400 / 422),没带对 key 也是 401;接口不在 ⇒ 路由层 404 / 405。
 * 实测 api.openai.com(2026-11-12,无 key 与假 key 各一遍):`POST /v1/responses`、`/v1/chat/completions` 都是 401,
 * `POST /v1/<不存在>` 是 404 —— 路由先于鉴权判。new-api 未知的 `/v1/*` 走 `RelayNotFound`,同样 404。
 * 回的不是 JSON(把所有路径都兜成网页的那类站点给 200 + HTML)⇒ 当作没有。连不上 ⇒ undefined(说不准)。
 */
async function endpointServes(endpoint: string, path: string, apiKey: string, fetchImpl: Fetch): Promise<boolean | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url(endpoint, path), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 404 || response.status === 405) return false;
  return (response.headers.get('content-type') ?? '').includes('json');
}

const PROTOCOL_PATHS: Partial<Record<ApiKeyConnectionProtocol, string>> = {
  'openai-responses': '/responses',
  'openai-chat-completions': '/chat/completions',
};

/**
 * 这家讲得了好几种接口时,按地址选一种:按 `candidates` 的顺序,第一个这个地址有的就是它。
 * 一个都说不准 / 都没有 ⇒ `fallback`(这家声明的那一种,与改动前一样)。
 */
export async function detectEndpointProtocol(
  input: {
    endpoint: string;
    apiKey: string;
    candidates: readonly ApiKeyConnectionProtocol[];
    fallback: ApiKeyConnectionProtocol;
  },
  fetchImpl: Fetch = fetch
): Promise<ApiKeyConnectionProtocol> {
  for (const protocol of input.candidates) {
    const path = PROTOCOL_PATHS[protocol];
    if (!path) continue;
    if ((await endpointServes(input.endpoint, path, input.apiKey, fetchImpl)) === true) return protocol;
  }
  return input.fallback;
}
