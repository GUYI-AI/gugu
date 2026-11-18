import { expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

it('passes native session metadata and the resolved account context to the provider without another connection', async () => {
  const observe = vi.fn().mockResolvedValue(undefined);
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
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ cli: input.runContext.cli.kind === 'resolved' ? input.runContext.cli.path : undefined }), expect.objectContaining({ _meta: tier }));
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { await rt.stopSession('conv-1'); }
});

it('a tier-cache write failure does not prevent the actual conversation opening', async () => {
  const observe = vi.fn().mockRejectedValue(new Error('cache is read-only'));
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

it('forwards the persisted native id and host-resolved programs through runtime admission to buildSpawn', async () => {
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
      providerSessionId: 'stored-native', programs: { antigravity: '/managed/legacy-server' },
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
