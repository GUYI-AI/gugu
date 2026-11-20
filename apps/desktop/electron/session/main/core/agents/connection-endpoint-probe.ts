import { egress } from '@gugu/core/shared/egress'
import type { ModelProtocol } from '@gugu/session-core/models/custom-model';
import type { ConnectionModelList } from '@gugu/session-core/workspace-server/agent-config';

const PROBE_TIMEOUT_MS = 10_000;

type Fetch = typeof globalThis.fetch;
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
  fetchImpl: Fetch = egress.fetch
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
export async function verifyEndpointModel(input: Endpoint, modelId: string, fetchImpl: Fetch = egress.fetch): Promise<ConnectionModelList> {
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

type ProbeReason = 'unreachable' | 'unauthorized' | 'no-list' | 'no-model' | 'refused';
export type ProtocolProbe = {
  endpoints: { protocol: ModelProtocol; baseUrl: string }[];
  models: string[];
  failures: { step: 'models' | ModelProtocol; reason: ProbeReason }[];
};

/** The smallest generating request each protocol accepts; any 2xx proves the address speaks it. */
async function sendMinimal(fetchImpl: Fetch, input: Endpoint, modelId: string): Promise<'connected' | ProbeReason> {
  const { root, headers } = endpointRequest(input);
  headers.set('content-type', 'application/json');
  const messages = [{ role: 'user', content: 'OK' }];
  const probes: Partial<Record<ModelProtocol, { path: string; payload: unknown }>> = {
    'anthropic-messages': { path: '/messages', payload: { model: modelId, max_tokens: 1, messages } },
    'openai-chat-completions': { path: '/chat/completions', payload: { model: modelId, messages, max_tokens: 1 } },
    'openai-responses': { path: '/responses', payload: { model: modelId, input: 'OK', max_output_tokens: 16, store: false } },
    'gemini-generate-content': {
      path: `/models/${encodeURIComponent(modelId.replace(/^models\//, ''))}:generateContent`,
      payload: { contents: [{ role: 'user', parts: [{ text: 'OK' }] }], generationConfig: { maxOutputTokens: 1 } },
    },
  };
  const probe = probes[input.protocol];
  if (!probe) return 'refused';
  const response = await requestEndpoint(fetchImpl, root + probe.path, { method: 'POST', headers, body: JSON.stringify(probe.payload) });
  if (!response) return 'unreachable';
  await response.body?.cancel();
  if (response.ok) return 'connected';
  return response.status === 401 || response.status === 403 ? 'unauthorized' : 'refused';
}

/**
 * Finds which protocols a typed address answers: the model list first (`GET …/models`, OpenAI's shape, then Gemini's),
 * then one minimal request per protocol. A bare host is tried as given and with `/v1` for the OpenAI protocols; Gemini
 * is tried at the address without a trailing `/v1` (its requests add `/v1beta`). `hint` (what the path names) is tried
 * first. The connection test's request shapes are reused, so a record saved from here reads the same as one tested.
 */
export async function probeEndpointProtocols(
  input: { baseUrl: string; apiKey: string; modelId?: string; hint?: ModelProtocol },
  fetchImpl: Fetch = egress.fetch,
): Promise<ProtocolProbe> {
  const base = input.baseUrl.trim().replace(/\/+$/, '');
  const openaiBases = /\/v\d+(?:beta)?$/.test(base) ? [base] : [`${base}/v1`, base];
  const basesFor = (protocol: ModelProtocol) => protocol === 'anthropic-messages' || protocol === 'gemini-generate-content'
    ? [base.replace(/\/v1$/, '')] : openaiBases;
  const order: ModelProtocol[] = ['openai-chat-completions', 'anthropic-messages', 'openai-responses', 'gemini-generate-content'];
  if (input.hint && order.includes(input.hint)) order.sort((a, b) => Number(b === input.hint) - Number(a === input.hint));
  const failures: ProtocolProbe['failures'] = [];
  let models: string[] = [];
  const lists = [
    ...openaiBases.map((endpoint) => ({ endpoint, protocol: 'openai-chat-completions' as const })),
    ...basesFor('gemini-generate-content').map((endpoint) => ({ endpoint, protocol: 'gemini-generate-content' as const })),
  ];
  let unlisted: ProbeReason = 'no-list';
  for (const list of lists) {
    const listed = await listEndpointModels({ ...list, apiKey: input.apiKey }, fetchImpl);
    if (listed.kind === 'listed') { models = listed.models; break; }
    // What the last OpenAI-shaped list said is the reported reason, as before Gemini lists were read.
    if (listed.kind === 'unlisted' && list.endpoint === openaiBases.at(-1) && list.protocol !== 'gemini-generate-content') unlisted = listed.reason;
  }
  if (!models.length) failures.push({ step: 'models', reason: unlisted });
  const modelId = input.modelId ?? models[0];
  if (!modelId) {
    for (const protocol of order) failures.push({ step: protocol, reason: 'no-model' });
    return { endpoints: [], models, failures };
  }
  const endpoints: ProtocolProbe['endpoints'] = [];
  for (const protocol of order) {
    let last: ProbeReason = 'unreachable';
    for (const endpoint of basesFor(protocol)) {
      const result = await sendMinimal(fetchImpl, { endpoint, apiKey: input.apiKey, protocol }, modelId);
      if (result === 'connected') { endpoints.push({ protocol, baseUrl: endpoint }); break; }
      last = result;
    }
    if (!endpoints.some((entry) => entry.protocol === protocol)) failures.push({ step: protocol, reason: last });
  }
  return { endpoints, models, failures };
}
