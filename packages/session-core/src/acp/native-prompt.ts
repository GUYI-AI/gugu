import { createHash } from 'node:crypto';
import type { TranscriptFileRef } from './models/turn-files';
import { HOST_PROMPT_HASH } from './native-prompt-key';

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

export { HOST_PROMPT_HASH };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * The receipt a host prompt carries for the native text its agent recorded for it. The host keeps the person's words;
 * the agent's record holds what was sent (with the host's attachment lines and context), so only the receipt ties them.
 */
export const nativePromptDigest = hash;
export const nativePromptMeta = (blocks: unknown): Record<string, string> => ({ [HOST_PROMPT_HASH]: hash(nativePromptText(blocks).text) });

/**
 * The receipt of a user message as an agent's record holds it: its text blocks joined by line, as `nativePromptText`
 * joins the blocks sent. Codex records one joined text, Claude one block per block sent; both read back the same.
 */
export function recordedPromptDigest(message: { text: string; content?: readonly { type: string; text?: unknown }[] }): string {
  const texts = message.content?.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []);
  return hash(texts ? texts.join('\n') : message.text);
}

/** What the person sent with a prompt: their own words and the files they attached. */
export type HostPrompt = { text: string; files?: TranscriptFileRef[] };
export type NativePromptIndex = ReadonlyMap<string, HostPrompt | null>;

/** Only host-persisted user rows supply a boundary; a provider row or a tag name cannot supply one. */
export function indexNativePrompts(messages: Iterable<{ kind: string; role?: string; text?: string; files?: TranscriptFileRef[]; _meta?: Record<string, unknown> }>): NativePromptIndex {
  const index = new Map<string, HostPrompt | null>();
  for (const item of messages) {
    const digest = item._meta?.[HOST_PROMPT_HASH];
    if (item.kind !== 'message' || item.role !== 'user' || typeof item.text !== 'string' || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) continue;
    const prompt: HostPrompt = { text: item.text, ...(item.files?.length ? { files: item.files } : {}) };
    // Identical flattened bytes can have two original block boundaries. Do not guess in that case.
    if (index.has(digest) && !sameHostPrompt(index.get(digest), prompt)) index.set(digest, null);
    else index.set(digest, prompt);
  }
  return index;
}

export function sameHostPrompt(a: HostPrompt | null | undefined, b: HostPrompt | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function originalNativePrompt(nativeText: string, index: NativePromptIndex): string | null | undefined {
  const prompt = index.get(hash(nativeText));
  return prompt === undefined || prompt === null ? prompt : prompt.text;
}
