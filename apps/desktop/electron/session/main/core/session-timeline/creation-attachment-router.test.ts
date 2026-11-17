import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLife, type SessionLifePorts } from '../sessions/session-life';
import { SessionpageLocalDeliveryRouter, type SessionpageDeliveryTarget } from '../../../../sessionpage/session-injection';
import { createLocalSessionDeliveryBridge, localSessionDeliveryTarget, unregisterLocalSessionDelivery } from '../../../../sessionpage/local-session-delivery';
import { injectSessionMessageWhenReady, setPtyStartupGate } from '../sessions/impl/keystroke-injection';
import { recordPtyOutput } from '../pty/pty-output-activity';
import type { Pty } from '../pty/pty';
import type { Session } from '@shared/core/sessions/sessions';

const conversation = 'attachment-router-owner-fence';
const message = { id: 'attachment-first-input', text: 'kept first input', kind: 'session-direct' as const };
async function owner() {
  const life = new SessionLife({ sessions: () => [], allForks: () => [] } as unknown as SessionLifePorts);
  await life.signIn('owner-a');
  await Promise.resolve();
  return { life, fence: life.inputOwnerFence('owner-a') };
}

afterEach(() => { unregisterLocalSessionDelivery(conversation); vi.useRealTimers(); });

describe('attachment owner fence inside the production session-page router', () => {
  it.each(['owner', 'capability'] as const)('does not call the provider after an account switch during %s lookup', async boundary => {
    const { life, fence } = await owner();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const pause = async () => { entered.resolve(); await release.promise; };
    const inject = vi.fn(async () => true);
    const target: SessionpageDeliveryTarget = {
      liveSessionIdByAgent: () => conversation,
      deliveryKeyForSession: async () => { if (boundary === 'owner') await pause(); return conversation; },
      sessionProviderSurface: async () => { if (boundary === 'capability') await pause(); return { providerId: 'claude', surface: 'tui' }; },
      tryInjectSessionMessage: inject,
    };
    const router = new SessionpageLocalDeliveryRouter([target]);
    const refused = expect(router.tryInjectSessionMessage(conversation, message, fence)).rejects.toThrow('no longer active');
    await entered.promise;
    await life.signOut();
    release.resolve();
    await refused;
    expect(inject).not.toHaveBeenCalled();
  });

  it('does not make the second injection after a switch inside native wake admission', async () => {
    const { life, fence } = await owner();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let live = false;
    const bytes = vi.fn(async () => true);
    const target: SessionpageDeliveryTarget = {
      liveSessionIdByAgent: () => conversation,
      deliveryKeyForSession: () => conversation,
      sessionProviderSurface: () => live ? { providerId: 'claude', surface: 'tui' } : null,
      waitUntilReady: async () => { entered.resolve(); await release.promise; },
      tryInjectSessionMessage: bytes,
    };
    const router = new SessionpageLocalDeliveryRouter([target], { wakeSession: async () => { live = true; } });
    const attempt = async () => (await router.tryInjectSessionMessage(conversation, message, fence)) === false ? 'not-live' as const : true;
    const refused = expect(router.injectWithWake(conversation, attempt, undefined, fence)).rejects.toThrow('no longer active');
    await entered.promise;
    await life.signOut();
    await life.signIn('owner-a'); // Same account is still a new epoch.
    release.resolve();
    await refused;
    expect(bytes).not.toHaveBeenCalled();
  });

  it('carries the same fence through the real host bridge and PTY startup wait, before any write', async () => {
    const { life, fence } = await owner();
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const write = vi.fn();
    const pty = { write, onData: vi.fn(), onExit: vi.fn() } as unknown as Pty;
    recordPtyOutput(pty, Date.now() - 60_000);
    setPtyStartupGate(pty, gate.promise);
    const session = { id: conversation, projectId: 'project-a', providerId: 'opencode' } as Session;
    createLocalSessionDeliveryBridge().registerLive('attachment-agent', {
      sessionId: conversation, providerId: 'opencode',
      sendMessage: (input, beforeAdmission) => {
        entered.resolve();
        return injectSessionMessageWhenReady({ pty, session, message: input, beforeAdmission });
      },
    });
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget]);
    const refused = expect(router.tryInjectSessionMessage(conversation, message, fence)).rejects.toThrow('no longer active');
    await entered.promise;
    await life.signOut();
    gate.resolve();
    await refused;
    expect(write).not.toHaveBeenCalled();
  });

  it('still admits through that same bridge and real PTY write while the original epoch is active', async () => {
    const { fence } = await owner();
    const write = vi.fn();
    const pty = { write, onData: vi.fn(), onExit: vi.fn() } as unknown as Pty;
    recordPtyOutput(pty, Date.now() - 60_000);
    const session = { id: conversation, projectId: 'project-a', providerId: 'opencode' } as Session;
    createLocalSessionDeliveryBridge().registerLive('attachment-agent', {
      sessionId: conversation, providerId: 'opencode',
      sendMessage: (input, beforeAdmission) => injectSessionMessageWhenReady({ pty, session, message: input, beforeAdmission }),
    });
    const router = new SessionpageLocalDeliveryRouter([localSessionDeliveryTarget]);
    await expect(router.tryInjectSessionMessage(conversation, message, fence)).resolves.toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith(`${message.text}\r`);
  });

  it('checks again after the real PTY quiet timer, rather than trusting sender entry', async () => {
    vi.useFakeTimers();
    const { life, fence } = await owner();
    const write = vi.fn();
    let output: (() => void) | undefined;
    const pty = { write, onData: (cb: () => void) => { output = cb; }, onExit: vi.fn() } as unknown as Pty;
    const session = { id: conversation, projectId: 'project-a', providerId: 'opencode' } as Session;
    const refused = expect(injectSessionMessageWhenReady({ pty, session, message, beforeAdmission: fence })).rejects.toThrow('no longer active');
    output?.();
    await life.signOut();
    await vi.advanceTimersByTimeAsync(800);
    await refused;
    expect(write).not.toHaveBeenCalled();
  });
});
