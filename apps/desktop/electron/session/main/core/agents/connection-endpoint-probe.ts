import { CUSTOM_MODEL_PROBE_DEADLINE_MS, chatModel, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import { requestEndpoint } from './connection-endpoint-request';
import type { ConnectionModelList, CustomModelProtocolProbe } from '@gugu/session-core/workspace-server/agent-config';

type Fetch = typeof globalThis.fetch;
/** `deadline`: the whole check's limit, when this request is one of several (gugu-dev#1617). */
type Endpoint = { endpoint: string; apiKey: string; protocol: ModelProtocol; env?: NodeJS.ProcessEnv; deadline?: AbortSignal };

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

/**
 * The live picker only reads provider metadata. An explicit connection test can also check a named model.
 * https://platform.claude.com/docs/en/api/models/list
 * https://aistudio.google.com/api-reference/models
 */
export async function listEndpointModels(
  input: Endpoint,
  fetchImpl?: Fetch
): Promise<ConnectionModelList> {
  const { root, headers } = endpointRequest(input);
  const trace = { protocol: input.protocol, deadline: input.deadline };
  const result = await requestEndpoint<ConnectionModelList>(fetchImpl, root + '/models', { headers }, input.env, async (response) => {
    if (response.status === 401 || response.status === 403) return { kind: 'unlisted', reason: 'unauthorized' };
    if (!response.ok) return { kind: 'unlisted', reason: 'no-list' };
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { kind: 'unlisted', reason: 'no-list' };
    }
    const content = body as { data?: unknown; models?: unknown } | null;
    const gemini = input.protocol === 'gemini-generate-content';
    const data = gemini ? content?.models : content?.data;
    if (!Array.isArray(data)) return { kind: 'unlisted', reason: 'no-list' };
    const models = [
      ...new Set(
        data
          .map((entry) => entry && typeof entry === 'object' ? { ...entry, id: Reflect.get(entry, gemini ? 'name' : 'id') as unknown } : undefined)
          .filter((entry): entry is { id: string } => typeof entry?.id === 'string' && entry.id.trim().length > 0 && chatModel(entry))
          .map(({ id }) => gemini ? id.trim().replace(/^models\//, '') : id.trim())
      ),
    ].sort((a, b) => a.localeCompare(b));
    return models.length > 0 ? { kind: 'listed', models } : { kind: 'unlisted', reason: 'no-list' };
  }, trace);
  return result.ok ? result.value : { kind: 'unlisted', reason: result.reason };
}

/**
 * The output limit every generating probe asks for. OpenAI Responses refuses fewer than 16, and relays that serve Chat
 * through Responses pass a Chat `max_tokens` on as `max_output_tokens`, so a smaller limit reads as a refused protocol.
 */
export const PROBE_OUTPUT_TOKENS = 16;

/** Try a tiny request only after the person asks to test a named model. */
export async function verifyEndpointModel(input: Endpoint, modelId: string, fetchImpl?: Fetch): Promise<ConnectionModelList> {
  const { root, headers } = endpointRequest(input);
  headers.set('content-type', 'application/json');
  const messages = [{ role: 'user', content: 'OK' }];
  const probes = {
    'anthropic-messages': { path: '/messages/count_tokens', payload: { model: modelId, messages } },
    'openai-responses': { path: '/responses', payload: { model: modelId, input: 'OK', max_output_tokens: PROBE_OUTPUT_TOKENS, store: false } },
    'openai-chat-completions': { path: '/chat/completions', payload: { model: modelId, messages, max_completion_tokens: PROBE_OUTPUT_TOKENS } },
    'gemini-generate-content': {
      path: `/models/${encodeURIComponent(modelId.replace(/^models\//, ''))}:countTokens`,
      payload: { contents: [{ parts: [{ text: 'OK' }] }] },
    },
  };
  const { path, payload } = probes[input.protocol];
  const result = await requestEndpoint<ConnectionModelList>(fetchImpl, root + path, { method: 'POST', headers, body: JSON.stringify(payload) }, input.env, async (response) => {
    if (response.ok) return { kind: 'connected' };
    return { kind: 'unlisted', reason: response.status === 401 || response.status === 403 ? 'unauthorized' : 'unreachable' };
  }, { protocol: input.protocol, deadline: input.deadline });
  return result.ok ? result.value : { kind: 'unlisted', reason: result.reason };
}

export type ProtocolProbe = CustomModelProtocolProbe;
type ProbeReason = ProtocolProbe['failures'][number]['reason'];

/** The smallest generating request each protocol accepts; any 2xx proves the address speaks it. */
async function sendMinimal(fetchImpl: Fetch | undefined, input: Endpoint, modelId: string): Promise<'connected' | ProbeReason> {
  const { root, headers } = endpointRequest(input);
  headers.set('content-type', 'application/json');
  const messages = [{ role: 'user', content: 'OK' }];
  const probes: Partial<Record<ModelProtocol, { path: string; payload: unknown }>> = {
    'anthropic-messages': { path: '/messages', payload: { model: modelId, max_tokens: PROBE_OUTPUT_TOKENS, messages } },
    'openai-chat-completions': { path: '/chat/completions', payload: { model: modelId, messages, max_tokens: PROBE_OUTPUT_TOKENS } },
    'openai-responses': { path: '/responses', payload: { model: modelId, input: 'OK', max_output_tokens: PROBE_OUTPUT_TOKENS, store: false } },
    'gemini-generate-content': {
      path: `/models/${encodeURIComponent(modelId.replace(/^models\//, ''))}:generateContent`,
      payload: { contents: [{ role: 'user', parts: [{ text: 'OK' }] }], generationConfig: { maxOutputTokens: PROBE_OUTPUT_TOKENS } },
    },
  };
  const probe = probes[input.protocol];
  if (!probe) return 'refused';
  const result = await requestEndpoint<'connected' | ProbeReason>(fetchImpl, root + probe.path, { method: 'POST', headers, body: JSON.stringify(probe.payload) }, input.env, async (response) => {
    if (response.ok) return 'connected';
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    return await saysModelNotServed(response) ? 'model-not-found' : 'refused';
  }, { protocol: input.protocol, deadline: input.deadline });
  return result.ok ? result.value : result.reason;
}

const MODEL_NOT_SERVED = /model_not_found|not_found_error[^}]{0,200}\bmodel\b|\bmodels?\b[^"\n]{0,160}\b(?:not found|does not exist|not supported)\b/i;

/**
 * The address's own word that it does not offer the model: OpenAI and the relays shaped like it answer `model_not_found`,
 * Anthropic a `not_found_error` naming the model, Gemini a 404 saying the model is not found. Only that word is read
 * (as a yes/no), never passed on.
 */
async function saysModelNotServed(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 404) return false;
  return MODEL_NOT_SERVED.test((await response.text().catch(() => '')).slice(0, 4096));
}

/**
 * Finds which protocols a typed address answers: the model list (`GET …/models`, OpenAI's shape, then Gemini's) and one
 * minimal request per protocol. A bare host is tried as given and with `/v1` for the OpenAI protocols; Gemini is tried at
 * the address without a trailing `/v1` (its requests add `/v1beta`). `hint` (what the path names) leads the order.
 *
 * The model asked about is the one the person named; only without one is the first listed model used. The lists and the
 * protocols are asked side by side under one `deadline` (gugu-dev#1617: a relay answering each request in seconds made a
 * one-after-another check outlast the person); what has not answered by then is reported as timed out.
 */
export async function probeEndpointProtocols(
  input: { baseUrl: string; apiKey: string; modelId?: string; hint?: ModelProtocol; env?: NodeJS.ProcessEnv },
  fetchImpl?: Fetch,
  deadline: AbortSignal = AbortSignal.timeout(CUSTOM_MODEL_PROBE_DEADLINE_MS),
): Promise<ProtocolProbe> {
  const base = input.baseUrl.trim().replace(/\/+$/, '');
  const openaiBases = /\/v\d+(?:beta)?$/.test(base) ? [base] : [`${base}/v1`, base];
  const basesFor = (protocol: ModelProtocol) => protocol === 'anthropic-messages' || protocol === 'gemini-generate-content'
    ? [base.replace(/\/v1$/, '')] : openaiBases;
  const order: ModelProtocol[] = ['openai-chat-completions', 'anthropic-messages', 'openai-responses', 'gemini-generate-content'];
  if (input.hint && order.includes(input.hint)) order.sort((a, b) => Number(b === input.hint) - Number(a === input.hint));
  const request = { apiKey: input.apiKey, env: input.env, deadline };
  const lists = [
    ...openaiBases.map((endpoint) => ({ endpoint, protocol: 'openai-chat-completions' as const })),
    ...basesFor('gemini-generate-content').map((endpoint) => ({ endpoint, protocol: 'gemini-generate-content' as const })),
  ];
  const listing = Promise.all(lists.map((list) => listEndpointModels({ ...list, ...request }, fetchImpl)));
  /** Each protocol tries its bases in turn; the protocols run side by side. */
  const tryProtocols = (modelId: string) => Promise.all(order.map(async (protocol) => {
    let last: ProbeReason = 'unreachable';
    let refusedAt: string | undefined;
    for (const endpoint of basesFor(protocol)) {
      const result = await sendMinimal(fetchImpl, { endpoint, protocol, ...request }, modelId);
      if (result === 'connected') return { protocol, connected: endpoint, refusedAt };
      // 401/403: this path exists and only the key was refused. A later base's 404 for the same protocol does not take that back.
      if (result === 'unauthorized') refusedAt ??= endpoint;
      if (last !== 'unauthorized') last = result;
      if (result === 'model-not-found') return { protocol, unserved: endpoint, refusedAt, last };
      // The deadline has passed: there is no time left for this protocol's other base.
      if (result === 'timeout') break;
    }
    return { protocol, refusedAt, last };
  }));
  // A named model is asked about while the lists are read; without one, the lists name it first.
  const early = input.modelId ? tryProtocols(input.modelId) : undefined;
  const listed = await listing;
  const failures: ProtocolProbe['failures'] = [];
  const found = listed.find((list) => list.kind === 'listed');
  const models = found?.kind === 'listed' ? found.models : [];
  // What the last OpenAI-shaped list said is the reported reason, as before Gemini lists were read.
  const lastOpenAi = listed[openaiBases.length - 1];
  if (!models.length) failures.push({ step: 'models', reason: lastOpenAi?.kind === 'unlisted' ? lastOpenAi.reason : 'no-list' });
  const modelId = input.modelId ?? models[0];
  if (!modelId) {
    for (const protocol of order) failures.push({ step: protocol, reason: 'no-model' });
    return { endpoints: [], models, failures };
  }
  const all = await (early ?? tryProtocols(modelId));
  // No protocol carried the model and one said it does not offer it: that word is the answer, as when the protocols were
  // asked one after another and the asking stopped there. A protocol that did carry it is never hidden by another's word.
  const firstUnserved = all.findIndex((answer) => answer.unserved);
  const answers = firstUnserved >= 0 && !all.some((answer) => answer.connected) ? all.slice(0, firstUnserved + 1) : all;
  const endpoints: ProtocolProbe['endpoints'] = [];
  const refused: ProtocolProbe['endpoints'] = [];
  const unserved: ProtocolProbe['endpoints'] = [];
  for (const answer of answers) {
    if (answer.refusedAt) refused.push({ protocol: answer.protocol, baseUrl: answer.refusedAt });
    if (answer.connected) { endpoints.push({ protocol: answer.protocol, baseUrl: answer.connected }); continue; }
    if (answer.unserved) unserved.push({ protocol: answer.protocol, baseUrl: answer.unserved });
    failures.push({ step: answer.protocol, reason: answer.last ?? 'unreachable' });
  }
  return { endpoints, models, failures, ...(refused.length ? { refused } : {}), ...(unserved.length ? { unserved } : {}) };
}
