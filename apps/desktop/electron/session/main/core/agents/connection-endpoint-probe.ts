import type { ModelProtocol } from '@gugu/session-core/models/custom-model';
import type { ConnectionModelList } from '@gugu/session-core/workspace-server/agent-config';

const PROBE_TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;
type Endpoint = { endpoint: string; apiKey: string; protocol: ModelProtocol };

function endpointRequest(input: Endpoint) {
  const root = input.endpoint.replace(/\/+$/, '');
  const headers = new Headers({ accept: 'application/json' });
  if (input.protocol === 'anthropic-messages') {
    headers.set('x-api-key', input.apiKey);
    headers.set('anthropic-version', '2023-06-01');
    return { root: root.replace(/\/v1$/, '') + '/v1', headers };
  }
  if (input.protocol === 'gemini-generate-content') {
    headers.set('x-goog-api-key', input.apiKey);
    return { root: root.endsWith('/v1beta') ? root : root + '/v1beta', headers };
  }
  headers.set('authorization', `Bearer ${input.apiKey}`);
  return { root, headers };
}

async function requestEndpoint(fetchImpl: Fetch, url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/**
 * The live picker only reads provider metadata. An explicit connection test can also check a named model.
 * https://platform.claude.com/docs/en/api/models/list
 * https://aistudio.google.com/api-reference/models
 */
export async function listEndpointModels(
  input: Endpoint,
  fetchImpl: Fetch = fetch
): Promise<ConnectionModelList> {
  const { root, headers } = endpointRequest(input);
  const response = await requestEndpoint(fetchImpl, root + '/models', { headers });
  if (!response) return { kind: 'unlisted', reason: 'unreachable' };
  if (response.status === 401 || response.status === 403) return { kind: 'unlisted', reason: 'unauthorized' };
  if (!response.ok) return { kind: 'unlisted', reason: 'no-list' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'unlisted', reason: 'no-list' };
  }
  const content = body as { data?: unknown; models?: unknown } | null;
  const gemini = input.protocol === 'gemini-generate-content';
  const data = gemini ? content?.models : content?.data;
  if (!Array.isArray(data)) return { kind: 'unlisted', reason: 'no-list' };
  const models = [
    ...new Set(
      data
        .map((entry) => entry && typeof entry === 'object' ? Reflect.get(entry, gemini ? 'name' : 'id') as unknown : undefined)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => gemini ? id.trim().replace(/^models\//, '') : id.trim())
    ),
  ].sort((a, b) => a.localeCompare(b));
  return models.length > 0 ? { kind: 'listed', models } : { kind: 'unlisted', reason: 'no-list' };
}

/** Try a tiny request only after the person asks to test a named model. */
export async function verifyEndpointModel(input: Endpoint, modelId: string, fetchImpl: Fetch = fetch): Promise<ConnectionModelList> {
  const { root, headers } = endpointRequest(input);
  headers.set('content-type', 'application/json');
  const messages = [{ role: 'user', content: 'OK' }];
  const probes = {
    'anthropic-messages': { path: '/messages/count_tokens', payload: { model: modelId, messages } },
    'openai-responses': { path: '/responses', payload: { model: modelId, input: 'OK', max_output_tokens: 16, store: false } },
    'openai-chat-completions': { path: '/chat/completions', payload: { model: modelId, messages, max_completion_tokens: 1 } },
    'gemini-generate-content': {
      path: `/models/${encodeURIComponent(modelId.replace(/^models\//, ''))}:countTokens`,
      payload: { contents: [{ parts: [{ text: 'OK' }] }] },
    },
  };
  const { path, payload } = probes[input.protocol];
  const response = await requestEndpoint(fetchImpl, root + path, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!response) return { kind: 'unlisted', reason: 'unreachable' };
  await response.body?.cancel();
  if (response.ok) return { kind: 'connected' };
  return { kind: 'unlisted', reason: response.status === 401 || response.status === 403 ? 'unauthorized' : 'unreachable' };
}
