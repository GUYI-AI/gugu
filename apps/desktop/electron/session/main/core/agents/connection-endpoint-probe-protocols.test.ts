import { expect, it } from 'vitest';
import { probeEndpointProtocols } from './connection-endpoint-probe';

// A relay at a bare host that serves OpenAI Chat and Anthropic Messages under /v1, but not Responses.
function relay(calls: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const key = new Headers(init?.headers).get('authorization') ?? new Headers(init?.headers).get('x-api-key');
    if (!key?.includes('test-key')) return new Response('', { status: 401 });
    if (path === '/v1/models') return Response.json({ data: [{ id: 'glm-5' }, { id: 'kimi' }] });
    if (path === '/v1/chat/completions' || path === '/v1/messages') return Response.json({ ok: true });
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

it('records every protocol a bare host answers, with the base that answered', async () => {
  const calls: string[] = [];
  const result = await probeEndpointProtocols({ baseUrl: 'https://relay.test', apiKey: 'test-key' }, relay(calls));
  expect(result.models).toEqual(['glm-5', 'kimi']);
  expect(result.endpoints).toEqual([
    { protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' },
    { protocol: 'anthropic-messages', baseUrl: 'https://relay.test' },
  ]);
  expect(result.failures).toEqual([
    { step: 'openai-responses', reason: 'refused' },
    // This relay answers 401 to any request without its OpenAI/Anthropic credential header.
    { step: 'gemini-generate-content', reason: 'unauthorized' },
  ]);
  expect(calls[0]).toBe('GET /v1/models');
});

it('tries the protocol the path names first, and says which step failed when nothing answers', async () => {
  const calls: string[] = [];
  await probeEndpointProtocols({ baseUrl: 'https://relay.test', apiKey: 'test-key', modelId: 'glm-5', hint: 'anthropic-messages' }, relay(calls));
  expect(calls[1]).toBe('POST /v1/messages');
  const refused = await probeEndpointProtocols({ baseUrl: 'https://relay.test', apiKey: 'wrong' }, relay([]));
  expect(refused.endpoints).toEqual([]);
  expect(refused.failures[0]).toEqual({ step: 'models', reason: 'unauthorized' });
  expect(refused.failures.slice(1).every(({ reason }) => reason === 'no-model')).toBe(true);
});

// A Gemini-compatible relay (`x-goog-api-key`, `/v1beta/models`, `…:generateContent`), optionally also speaking OpenAI Chat.
function geminiRelay(calls: string[], alsoOpenAi: boolean): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const headers = new Headers(init?.headers);
    const geminiKey = headers.get('x-goog-api-key');
    if (geminiKey) {
      if (geminiKey !== 'test-key') return new Response('', { status: 401 });
      if (path === '/gateway/v1beta/models') return Response.json({ models: [{ name: 'models/glm-5.3-flash' }] });
      if (path === '/gateway/v1beta/models/glm-5.3-flash:generateContent') return Response.json({ candidates: [] });
      return new Response('', { status: 404 });
    }
    if (!alsoOpenAi) return new Response('', { status: 404 });
    if (headers.get('authorization') !== 'Bearer test-key') return new Response('', { status: 401 });
    if (path === '/gateway/v1/models') return Response.json({ data: [{ id: 'glm-5.3-flash' }] });
    if (path === '/gateway/v1/chat/completions') return Response.json({ ok: true });
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

it('records Gemini alongside the other protocols a typed address answers', async () => {
  const calls: string[] = [];
  const result = await probeEndpointProtocols({ baseUrl: 'https://relay.test/gateway', apiKey: 'test-key' }, geminiRelay(calls, true));
  expect(result.endpoints).toEqual([
    { protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/gateway/v1' },
    { protocol: 'gemini-generate-content', baseUrl: 'https://relay.test/gateway' },
  ]);
  expect(calls).toContain('POST /gateway/v1beta/models/glm-5.3-flash:generateContent');
});

it('keeps a Gemini-only address Gemini when it is probed again, e.g. after its key changes', async () => {
  const result = await probeEndpointProtocols({ baseUrl: 'https://relay.test/gateway', apiKey: 'test-key' }, geminiRelay([], false));
  expect(result.models).toEqual(['glm-5.3-flash']);
  expect(result.endpoints).toEqual([{ protocol: 'gemini-generate-content', baseUrl: 'https://relay.test/gateway' }]);
  expect(result.failures).toEqual([
    { step: 'openai-chat-completions', reason: 'refused' },
    { step: 'anthropic-messages', reason: 'refused' },
    { step: 'openai-responses', reason: 'refused' },
  ]);
});
