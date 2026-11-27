import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins';
import { preApproveGuguTool } from './pre-approve';
import { GUGU_MCP_STDIO_RELAY_ENTRY_ENV, materializeAntigravitySessionBundle } from './session-bundle';

const RELAY = '/app/dist-electron/runtime/gugu-mcp-stdio-relay.mjs';
const CONVERSATION = '11111111-2222-3333-4444-555555555555';
const acp = { surface: 'acp' as const, lifecycle: 'fresh' as const, cwd: '/work' };
const entry = (name: string) => ({ command: process.execPath, args: [RELAY, name], env: { ELECTRON_RUN_AS_NODE: '1' }, disabled: false });

describe('antigravity chat leg MCP delivery', () => {
  let guguHome: string;
  beforeEach(() => {
    guguHome = mkdtempSync(join(tmpdir(), 'gugu-agy-acp-'));
    vi.stubEnv(GUGU_MCP_STDIO_RELAY_ENTRY_ENV, RELAY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(guguHome, { recursive: true, force: true });
  });

  const managed = () => join(guguHome, 'agent-homes', 'antigravity', '.gemini');
  const stored = (store: 'antigravity-acp' | 'antigravity-cli') => {
    mkdirSync(join(managed(), store, 'conversations'), { recursive: true });
    writeFileSync(join(managed(), store, 'conversations', `${CONVERSATION}.db`), '');
  };
  const bundle = (): SessionCapabilityBundle => ({
    mcpServers: [
      { name: 'gugu', transport: 'http', url: 'http://127.0.0.1:1/mcp', authorizationEnv: 'GUGU_MCP_TOKEN', owner: 'gugu' },
      { name: 'browser-use', transport: 'http', url: 'http://127.0.0.1:2/mcp', authorizationEnv: 'APP_TOKEN', owner: 'integration' },
      { name: 'mine', transport: 'stdio', command: 'x', args: ['serve'], env: { KEY: 'MINE_KEY' }, owner: 'integration', library: true },
      { name: 'remote', transport: 'http', url: 'https://example.invalid/mcp', authorizationEnv: 'REMOTE_AUTH', owner: 'integration', library: true },
    ],
    env: { GUGU_HOME: guguHome, GUGU_MCP_TOKEN: 'Bearer tok-1', APP_TOKEN: 'Bearer tok-2', MINE_KEY: 'k', REMOTE_AUTH: 'Basic abc' },
    model: null,
    autonomy: null,
    promptBlocks: { platform: 'P', identity: 'I' },
    packages: [],
  });

  it('agy: hosted servers go through the managed config relay under new names, the person\'s own stay on session/new', () => {
    const result = materializeAntigravitySessionBundle(acp, bundle());
    expect(result.acp?.mcpServers.map((server) => server.name)).toEqual(['mine', 'remote']);
    // Their own credential travels as they wrote it; the relay speaks Bearer only.
    expect(result.acp?.mcpServers[1]).toMatchObject({ headers: [{ name: 'Authorization', value: 'Basic abc' }] });
    expect(result.jsonOverlays).toEqual([{
      sourcePath: join(managed(), 'config', 'mcp_config.json'),
      path: join(managed(), 'config', 'mcp_config.json'),
      // A conversation stored these servers under their own names, and a same-named entry would stay eager.
      patch: { mcpServers: { 'gugu-mcp': entry('gugu-mcp'), 'browser-use-gugu': entry('browser-use-gugu') } },
      conflict: 'gugu-owns',
      mode: 0o600,
    }]);
    expect(result.env).toMatchObject({
      GUGU_SESSION_MCP_URL_GUGU_MCP: 'http://127.0.0.1:1/mcp',
      GUGU_SESSION_MCP_BEARER_GUGU_MCP: 'tok-1',
      GUGU_SESSION_MCP_URL_BROWSER_USE_GUGU: 'http://127.0.0.1:2/mcp',
      GUGU_SESSION_MCP_BEARER_BROWSER_USE_GUGU: 'tok-2',
      MINE_KEY: 'k',
    });
    // A `gugu` entry the terminal leg left in the shared file gets no upstream in a chat session.
    expect(result.env).not.toHaveProperty('GUGU_SESSION_MCP_URL_GUGU');
    expect(result.env).not.toHaveProperty('GUGU_MCP_TOKEN');
    expect(JSON.stringify(result.jsonOverlays)).not.toMatch(/tok-|127\.0\.0\.1/);
    expect(result.promptAwaitsGuguTools).toBe(true);
    expect(result.report.units.mcp).toEqual({ status: 'loaded' });
  });

  it('decides by the store that holds the conversation: the legacy server keeps session/new, agy the relay', () => {
    const resumed = { ...acp, lifecycle: 'resume' as const, providerSessionId: CONVERSATION };
    stored('antigravity-cli');
    expect(materializeAntigravitySessionBundle(resumed, bundle()).promptAwaitsGuguTools).toBe(true);
    rmSync(join(managed(), 'antigravity-cli'), { recursive: true });

    stored('antigravity-acp');
    const legacy = materializeAntigravitySessionBundle(resumed, bundle());
    expect(legacy.acp?.mcpServers.map((server) => server.name)).toEqual(['gugu', 'browser-use', 'mine', 'remote']);
    expect(legacy.jsonOverlays).toBeUndefined();
    expect(legacy.promptAwaitsGuguTools).toBeUndefined();
    expect(Object.keys(legacy.env).filter((key) => key.startsWith('GUGU_SESSION_MCP_'))).toEqual([]);
  });

  it('a new name another session server already has takes one more suffix', () => {
    const base = bundle();
    const given: SessionCapabilityBundle = { ...base, mcpServers: [...base.mcpServers,
      { name: 'browser-use-gugu', transport: 'stdio', command: 'y', args: [], env: {}, owner: 'integration', library: true }] };
    const result = materializeAntigravitySessionBundle(acp, given);
    expect(result.acp?.mcpServers.map((server) => server.name)).toEqual(['mine', 'remote', 'browser-use-gugu']);
    expect(Object.keys((result.jsonOverlays![0]!.patch as { mcpServers: object }).mcpServers))
      .toEqual(['gugu-mcp', 'browser-use-gugu-gugu']);
  });

  it('no other server answers to `gugu-mcp`, so nothing else is addressed or approved as Gugu', () => {
    const base = bundle();
    const given: SessionCapabilityBundle = { ...base, mcpServers: [...base.mcpServers,
      { name: 'gugu-mcp', transport: 'stdio', command: 'y', args: [], env: {}, owner: 'integration', library: true }] };
    const result = materializeAntigravitySessionBundle(acp, given);
    expect(result.acp?.mcpServers.map((server) => server.name)).toEqual(['mine', 'remote', 'gugu-mcp-library']);
    expect(Object.keys((result.jsonOverlays![0]!.patch as { mcpServers: object }).mcpServers))
      .toEqual(['gugu-mcp', 'browser-use-gugu']);
    stored('antigravity-acp');
    const legacy = materializeAntigravitySessionBundle({ ...acp, lifecycle: 'resume', providerSessionId: CONVERSATION }, given);
    expect(legacy.acp?.mcpServers.map((server) => server.name)).not.toContain('gugu-mcp');
  });

  it('a session without Gugu\'s own server has nothing to wait for', () => {
    const result = materializeAntigravitySessionBundle(acp, { ...bundle(), mcpServers: [] });
    expect(result.promptAwaitsGuguTools).toBeUndefined();
    expect(result.jsonOverlays).toBeUndefined();
    expect(result.acp?.mcpServers).toEqual([]);
  });
});

describe('antigravity pre-approval', () => {
  const ask = (toolCall: Record<string, unknown>) => preApproveGuguTool({
    sessionId: 's',
    toolCall: { toolCallId: 't', ...toolCall },
    options: [
      { optionId: 'allow_always', name: 'Allow Always', kind: 'allow_always' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  } as RequestPermissionRequest);
  // Payloads as each server sent them (agy acp 1.5.16; agy_acp_server 1.4.5), 2026-11-27.
  const proxied = (server: string, tool: string) => ({
    kind: 'execute', title: `MCP Tool ${tool}`, rawInput: { ServerName: server, ToolName: tool, Arguments: { text: 'hi' } },
  });
  const legacy = (server: string, tool: string) => ({
    kind: 'other', title: `${server}_${tool}`, rawInput: { text: 'hi' }, _meta: { mcp: { server, tool }, is_mcp_tool_call: true },
  });

  it('approves Gugu\'s own tools once, under both of its names and on both servers', () => {
    expect(ask(proxied('gugu-mcp', 'message_send'))).toBe('allow');
    expect(ask(proxied('gugu', 'message_send'))).toBe('allow');
    expect(ask(legacy('gugu', 'session_message'))).toBe('allow');
  });

  it('still asks for every other tool', () => {
    // Exact names: another renamed server shares the suffix, and a lookalike is not Gugu's.
    expect(ask(proxied('browser-use-gugu', 'browser_click'))).toBeUndefined();
    expect(ask(proxied('my-gugu-mcp', 'message_send'))).toBeUndefined();
    expect(ask(proxied('gugu-mcp-mcp', 'message_send'))).toBeUndefined();
    expect(ask(proxied('browser-use', 'browser_click'))).toBeUndefined();
    expect(ask(legacy('connected-apps', 'send_mail'))).toBeUndefined();
    // A shell command or file edit that only looks like Gugu by its title.
    expect(ask({ kind: 'execute', title: 'MCP Tool message_send', rawInput: { CommandLine: 'echo' } })).toBeUndefined();
    expect(ask({ kind: 'execute', title: 'gugu_message_send', rawInput: { CommandLine: 'echo' } })).toBeUndefined();
    // Extra fields, another title or another kind are not the proxied call.
    expect(ask({ ...proxied('gugu', 'message_send'), rawInput: { ServerName: 'gugu', ToolName: 'message_send', CommandLine: 'rm' } })).toBeUndefined();
    expect(ask({ ...proxied('gugu', 'message_send'), title: 'Run something' })).toBeUndefined();
    expect(ask({ ...proxied('gugu', 'message_send'), kind: 'edit' })).toBeUndefined();
    expect(ask({ kind: 'other', title: 'Run mcp_gugu_message_send', rawInput: { text: 'hi' } })).toBeUndefined();
  });
});
