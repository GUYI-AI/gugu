import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns/turn';
import { HOST_PROMPT_HASH, indexNativePrompts, recordedPromptDigest, sameHostPrompt, type HostPrompt } from '../acp/native-prompt';

/** The host's own receipts of what a person sent (`native-prompt-receipts`), by digest: undefined = none kept. */
export type HostPromptReceipts = (digest: string) => HostPrompt | null | undefined;

/**
 * A person's prompt as they sent it, in place of the native prompt an agent's record holds for it.
 *
 * The host sends a person's words with lines of its own (where an attached file is, how to send it again) and the
 * agent records them as one prompt; only the host knows which were whose. Each prompt it sends carries the receipt of
 * the native text (`nativePromptMeta`), and the host keeps what the person sent under it: in the runtime's turn while it
 * runs, then in `receipts`. A record's user message with a receipt reads as what was sent: the person's words, the
 * files they attached, and the record's own pictures of them. Every recorded user message carries its receipt, so a
 * record's copy of a turn is the same turn as the runtime's (`identityKeys`) even when the person wrote nothing.
 */
export class HostPrompts {
  private readonly known = new Map<string, HostPrompt | null>();
  private readonly missed = new Set<string>();
  private version = 0;
  private restored = new WeakMap<TranscriptTurn, { version: number; complete: boolean; turn: TranscriptTurn }>();

  constructor(private readonly receipts?: HostPromptReceipts) {}

  /** The runtime's turn: what the person sent with each of its prompts, before any receipt is kept. */
  learn(turn: TranscriptTurn | null): void {
    if (!turn) return;
    for (const [digest, prompt] of indexNativePrompts(turn.items)) {
      if (this.known.has(digest) && sameHostPrompt(this.known.get(digest), prompt)) continue;
      this.known.set(digest, this.known.has(digest) ? null : prompt);
      this.missed.delete(digest);
      this.version += 1;
    }
  }

  /** A record's turns with their user messages as sent; a turn that does not change is the same object. */
  restore(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
    return turns.map((turn) => {
      const cached = this.restored.get(turn);
      if (cached && (cached.complete || cached.version === this.version)) return cached.turn;
      let complete = true;
      const items = turn.items.map((item) => {
        const one = this.restoreItem(item);
        if (one.unknown) complete = false;
        return one.item;
      });
      const next = items.every((item, index) => item === turn.items[index]) ? turn : { ...turn, items };
      this.restored.set(turn, { version: this.version, complete, turn: next });
      return next;
    });
  }

  private restoreItem(item: TranscriptItem): { item: TranscriptItem; unknown: boolean } {
    if (item.kind !== 'message' || item.role !== 'user' || typeof item._meta?.[HOST_PROMPT_HASH] === 'string') return { item, unknown: false };
    const digest = recordedPromptDigest(item);
    const sent = this.lookup(digest);
    const marked = { ...item, _meta: { ...item._meta, [HOST_PROMPT_HASH]: digest } };
    if (!sent) return { item: marked, unknown: sent === undefined };
    const { files: _recorded, annotations: _annotations, ...rest } = marked;
    return { item: { ...rest, text: sent.text, content: [{ type: 'text', text: sent.text }], ...(sent.files?.length ? { files: sent.files } : {}),
      ...(sent.annotations?.length ? { annotations: sent.annotations } : {}) }, unknown: false };
  }

  private lookup(digest: string): HostPrompt | null | undefined {
    if (this.known.has(digest)) return this.known.get(digest);
    if (this.missed.has(digest) || !this.receipts) return undefined;
    const kept = this.receipts(digest);
    if (kept === undefined) this.missed.add(digest);
    else this.known.set(digest, kept);
    return kept;
  }
}
