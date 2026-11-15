/**
 * #2507 Antigravity 的 API Key 连接 = agy 的网关认证,按进程选。
 *  · 连接进程(agy 在 initialize 里报了 `gateway`):开第一条会话前 `authenticate {methodId:'gateway'}`,一次;线上不带 key。
 *  · Google 账号进程(它不报):一个请求都不多发,其余请求原样过。
 */
import { describe, expect, it } from 'vitest';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { ANTIGRAVITY_GATEWAY_METHOD, withGatewayAuthentication } from './api-key-connection';

type Call = { method: string; params: unknown };

function fakeAgy(options: { advertiseGateway: boolean; authenticateFails?: boolean }) {
  const calls: Call[] = [];
  const authMethods = [{ id: 'oauth-personal', name: 'Google' }, ...(options.advertiseGateway ? [{ id: 'gateway', name: 'AI API Gateway' }] : [])];
  const api = {
    initialize: async (params: unknown) => {
      calls.push({ method: 'initialize', params });
      return { protocolVersion: 1, authMethods, agentCapabilities: { loadSession: true } };
    },
    authenticate: async (params: unknown) => {
      calls.push({ method: 'authenticate', params });
      if (options.authenticateFails) throw new Error('authenticate(gateway): Gateway authentication could not be configured');
      return {};
    },
    newSession: async (params: unknown) => {
      calls.push({ method: 'newSession', params });
      return { sessionId: `s${calls.length}` };
    },
    loadSession: async (params: unknown) => {
      calls.push({ method: 'loadSession', params });
      return {};
    },
    prompt: async (params: unknown) => {
      calls.push({ method: 'prompt', params });
      return { stopReason: 'end_turn' };
    },
    cancel: async (params: unknown) => {
      calls.push({ method: 'cancel', params });
    },
  };
  return { api: api as unknown as AcpAgentApi, calls };
}

const initializeParams = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    auth: { terminal: {} },
    _meta: { jetbrains: { air: { version: 1 } } },
  },
} as unknown as Parameters<AcpAgentApi['initialize']>[0];

describe('Antigravity API key connection: the gateway auth method, chosen per process', () => {
  it('asks for the gateway capability in initialize, keeping every capability the host already declared', async () => {
    const { api, calls } = fakeAgy({ advertiseGateway: false });
    await withGatewayAuthentication(api).initialize(initializeParams);
    expect(calls[0]!.params).toEqual({
      ...initializeParams,
      clientCapabilities: { ...initializeParams.clientCapabilities, auth: { terminal: {}, _meta: { gateway: true } } },
    });
  });

  it('connection process: authenticate(gateway) once, before the first session, with no key on the wire', async () => {
    const { api, calls } = fakeAgy({ advertiseGateway: true });
    const wrapped = withGatewayAuthentication(api);
    await wrapped.initialize(initializeParams);
    const session = await wrapped.newSession({ cwd: '/work', mcpServers: [] });
    await wrapped.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    await wrapped.newSession({ cwd: '/work', mcpServers: [] });
    await wrapped.loadSession!({ sessionId: 'old', cwd: '/work', mcpServers: [] });
    expect(calls.map((call) => call.method)).toEqual(['initialize', 'authenticate', 'newSession', 'prompt', 'newSession', 'loadSession']);
    expect(calls[1]!.params).toEqual({ methodId: ANTIGRAVITY_GATEWAY_METHOD });
  });

  it('a resumed conversation also authenticates first (loadSession is the first request)', async () => {
    const { api, calls } = fakeAgy({ advertiseGateway: true });
    const wrapped = withGatewayAuthentication(api);
    await wrapped.initialize(initializeParams);
    await wrapped.loadSession!({ sessionId: 'old', cwd: '/work', mcpServers: [] });
    expect(calls.map((call) => call.method)).toEqual(['initialize', 'authenticate', 'loadSession']);
  });

  it('Google account process (gateway not advertised): no extra request, every other request passes through as is', async () => {
    const { api, calls } = fakeAgy({ advertiseGateway: false });
    const wrapped = withGatewayAuthentication(api);
    await wrapped.initialize(initializeParams);
    const newSession = { cwd: '/work', mcpServers: [] };
    const session = await wrapped.newSession(newSession);
    const prompt = { sessionId: session.sessionId, prompt: [{ type: 'text' as const, text: 'hi' }] };
    expect(await wrapped.prompt(prompt)).toEqual({ stopReason: 'end_turn' });
    await wrapped.cancel({ sessionId: session.sessionId });
    expect(calls.map((call) => call.method)).toEqual(['initialize', 'newSession', 'prompt', 'cancel']);
    expect(calls[1]!.params).toBe(newSession);
    expect(calls[2]!.params).toBe(prompt);
  });

  it('a gateway it cannot configure fails the session open with its own words, and opens nothing', async () => {
    const { api, calls } = fakeAgy({ advertiseGateway: true, authenticateFails: true });
    const wrapped = withGatewayAuthentication(api);
    await wrapped.initialize(initializeParams);
    await expect(wrapped.newSession({ cwd: '/work', mcpServers: [] })).rejects.toThrow(/Gateway authentication could not be configured/);
    expect(calls.map((call) => call.method)).toEqual(['initialize', 'authenticate']);
  });
});
