import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const antigravitySessionProgram = pluginRegistry.get('antigravity')!.behavior.acp!.sessionProgram!;

it('binds the observer before the native open, then hands it that open\'s metadata without another connection', async () => {
  const seen = vi.fn().mockResolvedValue(undefined);
  const observe = vi.fn().mockResolvedValue(seen);
  const spawn = vi.fn(() => ({ command: '/fake/node', args: ['agent.js'], env: {} }));
  const h = makeAcpHarness({ acpBehavior: {
    buildSpawn: spawn,
    connect: (io, client) => h.agent.behavior.connect(io, client),
    observeSessionMetadata: observe,
  } });
  const tier = { antigravity: { tier: { name: 'Google AI Pro' } } };
  h.agent.newSession.mockResolvedValue({ sessionId: 'new-native', _meta: tier });
  const rt = new AcpRuntime(h.deps);
  const input = makeStartInput();
  try {
    expect((await rt.startSession(input)).success).toBe(true);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ cli: input.runContext.cli.kind === 'resolved' ? input.runContext.cli.path : undefined }));
    expect(observe.mock.invocationCallOrder[0]).toBeLessThan(h.agent.newSession.mock.invocationCallOrder[0]!);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ _meta: tier }));
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await rt.stopSession('conv-1'); }
});

it('a tier-cache write failure does not prevent the actual conversation opening', async () => {
  const observe = vi.fn().mockResolvedValue(vi.fn().mockRejectedValue(new Error('cache is read-only')));
  const h = makeAcpHarness({ acpBehavior: {
    buildSpawn: () => ({ command: '/fake/node', args: ['agent.js'], env: {} }),
    connect: (io, client) => h.agent.behavior.connect(io, client),
    observeSessionMetadata: observe,
  } });
  const rt = new AcpRuntime(h.deps);
  try {
    expect((await rt.startSession(makeStartInput())).success).toBe(true);
    expect(observe).toHaveBeenCalledOnce();
  } finally { await rt.stopSession('conv-1'); }
});

it('forwards the store selected at open and the host-resolved programs through runtime admission to buildSpawn', async () => {
  const spawn = vi.fn(() => ({ command: '/fake/node', args: ['agent.js'], env: {} }));
  const h = makeAcpHarness({ acpBehavior: {
    buildSpawn: spawn, connect: (io, client) => h.agent.behavior.connect(io, client),
  } });
  h.agent.initialize.mockResolvedValue({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  const rt = new AcpRuntime(h.deps);
  const input = makeStartInput({ providerSessionId: 'stored-native' });
  input.runContext.programs = { antigravity: '/managed/legacy-server' };
  try {
    expect((await rt.startSession(input)).success).toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionProgram: null, programs: { antigravity: '/managed/legacy-server' },
    }));
  } finally { await rt.stopSession('conv-1'); }
});

it('can resume a native legacy store even when the default new CLI is missing', async () => {
  const spawn = vi.fn((ctx) => ({ command: ctx.cli, args: [], env: {} }));
  const h = makeAcpHarness({ acpBehavior: {
    sessionProgram: () => 'legacy', buildSpawn: spawn,
    connect: (io, client) => h.agent.behavior.connect(io, client),
  } });
  h.agent.initialize.mockResolvedValue({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  const rt = new AcpRuntime(h.deps);
  const input = makeStartInput({ providerSessionId: 'stored-native' });
  input.runContext.cli = { kind: 'unresolved', message: 'new CLI not installed' };
  input.runContext.programs = { legacy: '/managed/legacy-server' };
  try {
    expect((await rt.startSession(input)).success).toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cli: '/managed/legacy-server' }));
  } finally { await rt.stopSession('conv-1'); }
});

it('selects the native program once and carries it through startup and provider hooks', async () => {
  const select = vi.fn().mockReturnValueOnce('legacy').mockImplementation(() => { throw new Error('store is no longer visible'); });
  const prepare = vi.fn().mockResolvedValue(undefined);
  const observe = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined));
  const ended = vi.fn().mockResolvedValue(null);
  const spawn = vi.fn((ctx) => ({ command: ctx.cli, args: [], env: {} }));
  const h = makeAcpHarness({ acpBehavior: {
    sessionProgram: select, buildSpawn: spawn, prepareSession: prepare,
    observeSessionMetadata: observe, onTurnEnded: ended,
    connect: (io, client) => h.agent.behavior.connect(io, client),
  } });
  h.agent.initialize.mockResolvedValue({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  h.agent.prompt.mockResolvedValue({ stopReason: 'end_turn' });
  const rt = new AcpRuntime(h.deps);
  const input = makeStartInput({ providerSessionId: 'stored-native' });
  input.runContext.programs = { legacy: '/managed/legacy-server' };
  try {
    expect((await rt.startSession(input)).success).toBe(true);
    await rt.sendPrompt('conv-1', { text: 'check hook route' });
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce());
    expect(select).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ sessionProgram: 'legacy' }));
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionProgram: 'legacy' }));
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ sessionProgram: 'legacy' }));
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ sessionProgram: 'legacy' }));
  } finally { await rt.stopSession('conv-1'); }
});


it.each([
  ['used conversation', false, 'provider_session_missing'],
  ['never-run resident agent', true, 'new'],
])('recovers from Antigravity store lookup: %s', async (_label, fresh, expected) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-missing-runtime-'));
  const h = makeAcpHarness({ acpBehavior: {
    buildSpawn: (ctx) => ({ command: ctx.cli, args: [], env: {} }),
    connect: (io, client) => h.agent.behavior.connect(io, client),
    sessionProgram: antigravitySessionProgram,
  } });
  h.agent.newSession.mockResolvedValue({ sessionId: 'fresh-native' });
  const rt = new AcpRuntime(h.deps);
  const input = makeStartInput({
    providerSessionId: '11111111-2222-4333-8444-555555555555',
    freshIfProviderSessionMissing: fresh,
  });
  input.runContext.env.GEMINI_HOME = root;
  try {
    const result = await rt.resumeSession({ ...input, providerSessionId: input.providerSessionId! });
    if (expected === 'new') {
      expect(result).toMatchObject({ success: true, data: { providerSessionId: 'fresh-native' } });
      expect(h.agent.newSession).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({ success: false, error: { type: expected } });
      expect(h.agent.newSession).not.toHaveBeenCalled();
    }
    expect(h.agent.loadSession).not.toHaveBeenCalled();
    expect(h.agent.prompt).not.toHaveBeenCalled();
  } finally {
    await rt.stopSession(input.sessionId);
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['both stores', 'lookup failure'] as const)('rejects %s even with permission to start fresh', async (condition) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-unknown-runtime-'));
  const id = '11111111-2222-4333-8444-555555555555';
  const h = makeAcpHarness({ acpBehavior: {
    buildSpawn: (ctx) => ({ command: ctx.cli, args: [], env: {} }),
    connect: (io, client) => h.agent.behavior.connect(io, client),
    sessionProgram: antigravitySessionProgram,
  } });
  const rt = new AcpRuntime(h.deps);
  const input = makeStartInput({ providerSessionId: id, freshIfProviderSessionMissing: true });
  input.runContext.env.GEMINI_HOME = root;
  try {
    if (condition === 'both stores') {
      for (const store of ['antigravity-acp', 'antigravity-cli']) {
        const dir = join(root, store, 'conversations');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${id}.db`), 'fake SQLite');
      }
    } else {
      await writeFile(join(root, 'antigravity-acp'), 'a file where a directory should be');
    }
    expect(await rt.resumeSession({ ...input, providerSessionId: id })).toMatchObject({
      success: false, error: { type: 'initialize_failed' },
    });
    expect(h.agent.newSession).not.toHaveBeenCalled();
  } finally {
    await rt.stopSession(input.sessionId);
    await rm(root, { recursive: true, force: true });
  }
});
