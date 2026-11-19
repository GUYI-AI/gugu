import { createHash } from 'node:crypto';

/**
 * The text an agent records for a prompt: its text blocks (resources as their text) joined by line, as Hermes submits it
 * and as Codex records it. Images remain separate attachments.
 */
export function nativePromptText(blocks: unknown): { text: string; images: { data: string; mimeType: string }[] } {
  const list = Array.isArray(blocks) ? blocks as Record<string, unknown>[] : [];
  const texts: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const block of list) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image' && typeof block.data === 'string') images.push({ data: block.data, mimeType: String(block.mimeType ?? 'image/png') });
    else if (block.type === 'resource_link' && typeof block.uri === 'string') texts.push(block.uri);
    else if (block.type === 'resource' && typeof (block.resource as Record<string, unknown> | undefined)?.text === 'string') texts.push(String((block.resource as Record<string, unknown>).text));
  }
  return { text: texts.join('\n'), images };
}

// The key predates Codex receipts: stored Hermes rows already carry it.
const HOST_PROMPT_HASH = 'gugu.hermesNativePromptSha256';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * The receipt a host prompt carries for the native text its agent recorded for it. The host keeps the person's words;
 * the agent's record holds what was sent (with the host's attachment lines and context), so only the receipt ties them.
 */
export const nativePromptDigest = hash;
export const nativePromptMeta = (blocks: unknown): Record<string, string> => ({ [HOST_PROMPT_HASH]: hash(nativePromptText(blocks).text) });
export type NativePromptIndex = ReadonlyMap<string, string | null>;

/** Only host-persisted user rows supply a boundary; a provider row or a tag name cannot supply one. */
export function indexNativePrompts(messages: Iterable<{ kind: string; role?: string; text?: string; _meta?: Record<string, unknown> }>): NativePromptIndex {
  const index = new Map<string, string | null>();
  for (const item of messages) {
    const digest = item._meta?.[HOST_PROMPT_HASH];
    if (item.kind !== 'message' || item.role !== 'user' || typeof item.text !== 'string' || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) continue;
    // Identical flattened bytes can have two original block boundaries. Do not guess in that case.
    if (index.has(digest) && index.get(digest) !== item.text) index.set(digest, null);
    else index.set(digest, item.text);
  }
  return index;
}

export function originalNativePrompt(nativeText: string, index: NativePromptIndex): string | null | undefined {
  return index.get(hash(nativeText));
}
