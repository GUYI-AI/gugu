import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLife, type SessionLifePorts } from '../sessions/session-life';
import { CodexAppServerSession } from '../../../../sessionpage/codex-app-server-delivery';
import { OpencodeServeSession } from '../../../../sessionpage/opencode-serve-attach-transport';
import { DroidDaemonSessionDelivery } from '../../../../sessionpage/droid-daemon-session-delivery';
import { claudeSessionDelivery } from '../../../../sessionpage/claude-session-delivery';

const net = vi.hoisted(() => ({ socket: null as unknown, connected: () => {} }));
vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(),
  createConnection: () => { net.connected(); return net.socket; },
}));
async function owner() {
  const life = new SessionLife({ sessions: () => [], allForks: () => [] } as unknown as SessionLifePorts);
  await life.signIn('native-owner-a');
  await Promise.resolve();
  return { life, fence: life.inputOwnerFence('native-owner-a') };
}
const claudeId = 'attachment-owner-native-claude';
afterEach(() => {
  claudeSessionDelivery.teardown(claudeId);
  claudeSessionDelivery.setSend(null);
  vi.restoreAllMocks();
});

describe('attachment owner fence at native transport admission after asynchronous preparation', () => {
  it('does not steer or enqueue bytes after Codex thread/read returns in a new epoch', async () => {
    const { life, fence } = await owner();
    const entered = Promise.withResolvers<void>(), read = Promise.withResolvers<unknown>();
    const rpc = vi.fn(async (method: string) => {
      if (method !== 'thread/read') throw new Error(`unexpected write ${method}`);
      entered.resolve();
      return read.promise;
    });
    const session = new CodexAppServerSession('attachment-codex', '/unused-test-command');
    const state = session as unknown as { client: { rpc: typeof rpc }; threadMaterialization: string };
    state.client = { rpc };
    state.threadMaterialization = 'materialized';
    session.threadId = 'thread-a';
    const refused = expect(session.deliver('private first input', fence)).rejects.toThrow('no longer active');
    await entered.promise;
    await life.signOut();
    read.resolve({ turns: [] });
    await refused;
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['thread/read']);
  }, 10_000);

  it('does not POST or register a phantom turn after the OpenCode current-agent read is revoked', async () => {
    const { life, fence } = await owner();
    const entered = Promise.withResolvers<void>(), read = Promise.withResolvers<string>();
    const session = new OpencodeServeSession(1, { providerId: 'opencode', command: '/unused-test-command', cwd: '/unused', env: {} });
    const state = session as unknown as {
      providerSessionId: string;
      readCurrentSessionAgent(id: string): Promise<string>;
      postJson(path: string, body: unknown): Promise<number>;
      turnWaiters: unknown[];
      busyWaiters: unknown[];
      awaitBusy(ms: number): Promise<void>;
    };
    state.providerSessionId = 'session-a';
    vi.spyOn(state, 'readCurrentSessionAgent').mockImplementation(async () => { entered.resolve(); return read.promise; });
    const post = vi.spyOn(state, 'postJson').mockResolvedValue(204);
    vi.spyOn(state, 'awaitBusy').mockResolvedValue();
    const refused = expect(session.injectPrompt('private first input', fence)).rejects.toThrow('no longer active');
    await entered.promise;
    await life.signOut();
    read.resolve('plan');
    await refused;
    expect(post).not.toHaveBeenCalled();
    expect(state.turnWaiters).toHaveLength(0);
    expect(state.busyWaiters).toHaveLength(0);
  }, 10_000);

  it('does not send a Droid RPC after daemon readiness finishes in a new epoch', async () => {
    const { life, fence } = await owner();
    const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
    const socket = Object.assign(new EventEmitter(), { send: vi.fn() });
    const daemon = new DroidDaemonSessionDelivery();
    daemon.register({ agentUserId: 'agent-a', sessionId: 'session-a', providerId: 'droid', providerSessionId: 'native-a', cwd: '/unused' });
    const state = daemon as unknown as { ensureDaemon(binding: unknown): Promise<{ socket: typeof socket }> };
    vi.spyOn(state, 'ensureDaemon').mockImplementation(async () => { entered.resolve(); await ready.promise; return { socket }; });
    const refused = expect(daemon.tryInjectSessionMessage('session-a', { id: 'message-a', text: 'private first input' }, fence)).rejects.toThrow('no longer active');
    await entered.promise;
    await life.signOut();
    ready.resolve();
    await refused;
    expect(socket.send).not.toHaveBeenCalled();
  }, 10_000);

  it('does not write the Claude reply/repaint payload when the real connection callback arrives after revocation', async () => {
    const { life, fence } = await owner();
    const connected = Promise.withResolvers<void>();
    const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
    net.socket = socket;
    net.connected = () => connected.resolve();
    claudeSessionDelivery.register({ guguAgentUserId: 'agent-a', sessionId: claudeId, cwd: '/unused', chatId: null, providerId: 'claude' }, { readySource: () => () => {} });
    claudeSessionDelivery.markReady(claudeId);
    const refused = expect(claudeSessionDelivery.tryInjectSessionMessage(claudeId, { id: 'message-a', text: 'private first input' }, fence)).rejects.toThrow('no longer active');
    await connected.promise;
    await life.signOut();
    socket.emit('connect');
    await refused;
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledOnce();
  }, 10_000);
});
