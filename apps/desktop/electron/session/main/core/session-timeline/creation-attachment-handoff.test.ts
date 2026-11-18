import { describe, expect, it, vi } from 'vitest';
import { handoffCreationAttachmentInput } from './creation-attachment-handoff';
import { SessionLife, type SessionLifePorts } from '../sessions/session-life';

const owner = { ownerId: 'owner-a', deviceId: 'device-a' };
const emptyLife = () => new SessionLife({ sessions: () => [], allForks: () => [] } as unknown as SessionLifePorts);
async function signedInLife() {
  const life = emptyLife(); await life.signIn(owner.ownerId);
  // The lifecycle's transition bookkeeping settles in its following microtask; no timer or polling.
  await Promise.resolve();
  return life;
}

describe('attachment first-input owner fence through lazy loading and custody', () => {
  it('does not call send when the account changes while the production sender is loading', async () => {
    let actual = owner, loaded!: () => void;
    const loading = new Promise<void>(resolve => { loaded = resolve; });
    const send = vi.fn(async (_guard: () => void) => {}), capture = vi.fn(() => () => {});
    const pending = handoffCreationAttachmentInput(owner, async () => actual, async () => { await loading; return { send, capture }; });
    actual = { ...owner, ownerId: 'owner-b' }; loaded();
    await expect(pending).rejects.toThrow('owner/device changed');
    expect(send).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  });
  it('binds the real synchronous lifecycle epoch even if an async auth snapshot completed under the old owner', async () => {
    const life = await signedInLife();
    const send = vi.fn(async (_guard: () => void) => {});
    await expect(handoffCreationAttachmentInput(owner, async () => {
      await life.signIn('owner-b'); return owner;
    }, async () => ({ send, capture: () => life.inputOwnerFence(owner.ownerId) }))).rejects.toThrow('no longer active');
    expect(send).not.toHaveBeenCalled();
  });
  it('the actual custody boundary rejects a sign-out after sender entry but before its asynchronous preparation finishes', async () => {
    const life = await signedInLife();
    const custody = vi.fn();
    await expect(handoffCreationAttachmentInput(owner, async () => owner, async () => ({
      capture: () => life.inputOwnerFence(owner.ownerId),
      send: async guard => { await life.signOut(); guard(); custody(); },
    }))).rejects.toThrow('no longer active');
    expect(custody).not.toHaveBeenCalled();
  });
  it('does not reuse an old epoch after the same account signs back in', async () => {
    const life = await signedInLife();
    const guard = life.inputOwnerFence(owner.ownerId); guard();
    await life.signOut(); await life.signIn(owner.ownerId);
    expect(guard).toThrow('no longer active');
  });
  it('refuses a different device even with the same account', async () => {
    const send = vi.fn(async (_guard: () => void) => {});
    await expect(handoffCreationAttachmentInput(owner, async () => ({ ...owner, deviceId: 'other-device' }), async () => ({ send, capture: () => () => {} }))).rejects.toThrow('owner/device changed');
    expect(send).not.toHaveBeenCalled();
  });
});
