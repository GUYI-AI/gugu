export type WindowOpeningInput = { conversationId: string; subscriptionId: string };
type Owner = { conversationId: string; stop(): void };
const rejected = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Only host closures hold runtime proofs. The client UUID identifies this
 * preparation, and the existing connection owner releases it on disconnect. */
export function createWindowOpenings(ports: {
  capture(conversationId: string): Promise<(() => boolean) | null>;
  register(subscriptionId: string, owner: Owner): () => void;
}) {
  const pending = new Map<string, { conversationId: string; proof?: () => boolean; stop(): void }>();
  return {
    async prepare(input: WindowOpeningInput): Promise<{ source: 'window' | 'legacy' }> {
      if (!input.subscriptionId.trim()) throw rejected('invalid_subscription', 'subscriptionId is required');
      if (pending.size >= 32) throw rejected('window_capacity', 'Too many pending history openings');
      let stopped = false;
      const owner = { conversationId: input.conversationId, proof: undefined as (() => boolean) | undefined,
        stop() { stopped = true; if (pending.get(input.subscriptionId) === owner) pending.delete(input.subscriptionId); forget?.(); } };
      const forget = ports.register(input.subscriptionId, owner);
      pending.set(input.subscriptionId, owner);
      try {
        owner.proof = (await ports.capture(input.conversationId)) ?? undefined;
        if (stopped) throw rejected('unsubscribed', 'History opening was released');
        if (!owner.proof) { owner.stop(); return { source: 'legacy' }; }
        return { source: 'window' };
      } catch (error) { owner.stop(); throw error; }
    },
    take(input: WindowOpeningInput): () => void {
      const owner = pending.get(input.subscriptionId);
      if (!owner || owner.conversationId !== input.conversationId || !owner.proof)
        throw rejected('scope_changed', 'This subscription has no stopped history proof');
      const proof = owner.proof;
      pending.delete(input.subscriptionId);
      return () => { if (!proof()) throw rejected('scope_changed', 'The stopped session changed while opening history'); };
    },
  };
}
