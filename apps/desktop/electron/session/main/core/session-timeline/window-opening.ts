import type { createWindowCommitRuntime } from './window-commit-runtime';
import type { WindowLiveCursor } from '@gugu/session-wire/session-window-live';
export type WindowOpeningInput = { conversationId: string; subscriptionId: string };
export type WindowOpeningLease = ReturnType<ReturnType<typeof createWindowCommitRuntime>['reserve']>;
export type WindowOpeningSelection = { source: 'legacy' } | { source: 'window'; liveCursor: WindowLiveCursor };
export type WindowOpeningProof = (() => void) & { live: WindowOpeningLease };
type Failure = Error & { code: string };
type Owner = { conversationId: string; live?: WindowOpeningLease; stop(): void };
const rejected = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Only host closures hold runtime proofs. The client UUID identifies this
 * preparation, and the existing connection owner releases it on disconnect. */
export function createWindowOpenings(ports: {
  capture(conversationId: string): Promise<(() => boolean) | null>;
  reserve(input: WindowOpeningInput, failed: (error: Failure) => void): WindowOpeningLease;
  register(subscriptionId: string, owner: Owner): () => void;
}) {
  type Opening = Owner & { proof?: () => boolean; prepared: boolean; transferred: boolean; error?: unknown; failed(error: Failure): void };
  const pending = new Map<string, Opening>();
  return {
    async prepare(input: WindowOpeningInput, failed: (error: Failure) => void = () => {}): Promise<WindowOpeningSelection> {
      if (!input.subscriptionId.trim()) throw rejected('invalid_subscription', 'subscriptionId is required');
      if (pending.size >= 32) throw rejected('window_capacity', 'Too many pending history openings');
      let stopped = false;
      const owner: Opening = { conversationId: input.conversationId, prepared: false, transferred: false, failed,
        stop() { stopped = true; if (!owner.transferred) owner.live?.close();
          if (pending.get(input.subscriptionId) === owner) pending.delete(input.subscriptionId); forget?.(); } };
      const forget = ports.register(input.subscriptionId, owner);
      pending.set(input.subscriptionId, owner);
      try {
        // Register before the first await, including for a not-yet-created worker.
        // A reservation error cannot change pre-read legacy source selection.
        try { owner.live = ports.reserve(input, error => {
          owner.error = error;
          if (owner.prepared) { if (!owner.transferred) owner.stop(); owner.failed(error); }
        }); } catch (error) { owner.error = error; }
        owner.proof = (await ports.capture(input.conversationId)) ?? undefined;
        if (stopped) throw rejected('unsubscribed', 'History opening was released');
        if (!owner.proof) { owner.stop(); return { source: 'legacy' }; }
        if (owner.error) throw owner.error;
        const liveCursor = await owner.live!.prepare();
        if (stopped) throw rejected('unsubscribed', 'History opening was released');
        if (owner.error) throw owner.error;
        if (!owner.proof()) throw rejected('scope_changed', 'The stopped session changed while preparing history');
        owner.prepared = true;
        return { source: 'window', liveCursor };
      } catch (error) { owner.stop(); throw error; }
    },
    take(input: WindowOpeningInput, failed: (error: Failure) => void = () => {}): WindowOpeningProof {
      const owner = pending.get(input.subscriptionId);
      if (!owner || owner.conversationId !== input.conversationId || !owner.proof || !owner.prepared || !owner.live)
        throw rejected('scope_changed', 'This subscription has no stopped history proof');
      const proof = owner.proof;
      if (!proof()) throw rejected('scope_changed', 'The stopped session changed while opening history');
      owner.transferred = true; owner.failed = failed;
      pending.delete(input.subscriptionId);
      return Object.assign(() => { if (!proof()) throw rejected('scope_changed', 'The stopped session changed while opening history'); }, { live: owner.live });
    },
  };
}
