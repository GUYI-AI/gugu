import { z } from 'zod';
import type { HarnessWireProtocol } from '../agents/plugins/capabilities/platform';

export const modelProtocolSchema = z.enum([
  'anthropic-messages', 'openai-responses', 'openai-chat-completions', 'gemini-generate-content',
]);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;

/** Keep the provider's root, including any version prefix the provider requires. */
export function normalizeModelBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) endpoint without credentials, query or fragment');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/(?:\/chat\/completions|\/responses|\/v1\/messages)$/, '');
  return url.toString().replace(/\/+$/, '');
}

/**
 * The protocol an address names by its own path, before any network request: the vendor's documented route tail or
 * prefix. `undefined` when the path doesn't say (a bare `/v1` is served by several protocols), so the person chooses.
 */
export function detectModelProtocol(value: string): ModelProtocol | undefined {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return undefined; }
  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (/\/(?:v1\/)?messages$/.test(path) || /(?:^|\/)anthropic$/.test(path)) return 'anthropic-messages';
  if (/\/responses$/.test(path)) return 'openai-responses';
  if (/\/chat\/completions$/.test(path) || /\/openai$/.test(path)) return 'openai-chat-completions';
  if (url.hostname === 'generativelanguage.googleapis.com' && /^\/v1(?:beta)?(?:\/models)?$/.test(path)) return 'gemini-generate-content';
  return undefined;
}

export const modelEndpointSchema = z.object({
  protocol: modelProtocolSchema,
  baseUrl: z.string().url().transform((value, ctx) => {
    try { return normalizeModelBaseUrl(value); }
    catch (error) { ctx.addIssue({ code: 'custom', message: String(error) }); return z.NEVER; }
  }),
});

export const customModelEntrySchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().max(200).optional(),
  image: z.boolean().optional(),
  thinking: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
});

export const customModelMetaSchema = z.object({
  preset: z.string().nullable(),
  endpoints: z.array(modelEndpointSchema).min(1).max(4)
    .refine((entries) => new Set(entries.map(({ protocol }) => protocol)).size === entries.length, 'Use one address per protocol'),
  models: z.array(customModelEntrySchema).max(200)
    .refine((entries) => new Set(entries.map(({ id }) => id)).size === entries.length, 'Model IDs must be unique'),
  removed: z.boolean().optional(),
});
export type CustomModelMeta = z.infer<typeof customModelMetaSchema>;
export type CustomModelEntry = z.infer<typeof customModelEntrySchema>;

/**
 * Whether a custom model takes image input. Only the person can say a model doesn't: no model list or Codex config
 * carries the fact, so an undeclared model is not refused here and the provider answers for itself.
 */
export function customModelAcceptsImages(entry: Pick<CustomModelEntry, 'image'> | undefined): boolean {
  return entry?.image !== false;
}

export type PiCustomModelProvider = {
  connectionId: string;
  name: string;
  baseUrl: string;
  protocol: 'openai-responses' | 'openai-chat-completions';
  models: readonly CustomModelEntry[];
};

/** A session owns this choice; changing another session or a default cannot replace it. */
export const sessionModelSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native'), modelId: z.string().optional() }),
  z.object({ kind: z.literal('platform'), modelId: z.string().min(1) }),
  z.object({ kind: z.literal('custom'), connectionId: z.string().uuid(), modelId: z.string().min(1).optional() }),
]);
export type SessionModelSelection = z.infer<typeof sessionModelSelectionSchema>;
export type CustomModelRef = Extract<SessionModelSelection, { kind: 'custom' }>;

/** Where a connection was found on this machine. Never carries the key or its fingerprint. */
export const discoverySourceSchema = z.enum(['codex-auth', 'codex-provider', 'shell-env']);
export type DiscoverySource = z.infer<typeof discoverySourceSchema>;

export const customModelConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  credentialRef: z.string(),
  keySaved: z.boolean(),
  ...customModelMetaSchema.shape,
  /**
   * Present when this machine already had the connection configured; `keyLast4` is all the wire carries of the key.
   * Only this computer's own window reads the whole key, through `CUSTOM_MODEL_KEY_CHANNEL`.
   */
  discovered: z.object({ source: discoverySourceSchema, keyLast4: z.string().max(4) }).optional(),
});
export type CustomModelConnection = z.infer<typeof customModelConnectionSchema>;

/** Electron IPC from this computer's own window: the key a connection reads with, to show it. Never on the device wire. */
export const CUSTOM_MODEL_KEY_CHANNEL = 'custom-models:key';

/** Option IDs retain both identities even when two providers use the same model ID. */
export function customModelOptionId(ref: Pick<CustomModelRef, 'connectionId' | 'modelId'>): string {
  return `custom:${ref.connectionId}:${ref.modelId ?? ''}`;
}

export function customModelRefFromOption(value: string | undefined | null): CustomModelRef | null {
  const parts = value?.match(/^custom:([\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}):([\s\S]*)$/);
  return parts ? { kind: 'custom', connectionId: parts[1]!, ...(parts[2] ? { modelId: parts[2] } : {}) } : null;
}

/** Every process/display boundary reads a stored model through the same decoder. */
export function runtimeModelId(value: string | undefined | null): string | undefined {
  const custom = customModelRefFromOption(value);
  return custom ? custom.modelId : value ?? undefined;
}

export type CustomModelUnavailableReason = 'protocol' | 'missing-key' | 'unsupported' | 'no-model';

/**
 * Native protocol wins, then the writer's other explicitly supported protocols, then a protocol the harness declares the
 * bundled local router can convert (`converted: true`).
 */
export function matchCustomModel(input: {
  nativeProtocol?: HarnessWireProtocol;
  protocols?: readonly HarnessWireProtocol[];
  convertFrom?: readonly HarnessWireProtocol[];
  allowDefaultModel?: boolean;
  hasModel?: boolean;
  connection: Pick<CustomModelConnection, 'endpoints' | 'keySaved'>;
}): { endpoint: CustomModelMeta['endpoints'][number]; converted?: true; reason?: never } | { endpoint?: never; converted?: never; reason: CustomModelUnavailableReason } {
  if (!input.nativeProtocol) return { reason: 'unsupported' };
  const find = (protocols: readonly HarnessWireProtocol[]) =>
    protocols.map((protocol) => input.connection.endpoints.find((item) => item.protocol === protocol)).find(Boolean);
  const direct = find([input.nativeProtocol, ...(input.protocols ?? [])]);
  const endpoint = direct ?? find(input.convertFrom ?? []);
  if (!endpoint) return { reason: 'protocol' };
  if (!input.connection.keySaved) return { reason: 'missing-key' };
  if (input.hasModel === false && !input.allowDefaultModel) return { reason: 'no-model' };
  return direct ? { endpoint } : { endpoint, converted: true };
}

/** Resolve only within the provider addressing reported by this running custom session. */
export function customModelRuntimeOption(ref: CustomModelRef, modelId: string, selected: string | null | undefined, advertised: readonly string[]): string | undefined {
  if (ref.modelId && selected?.endsWith(`/${ref.modelId}`)) {
    const candidate = selected.slice(0, -ref.modelId.length) + modelId;
    return advertised.includes(candidate) ? candidate : undefined;
  }
  return advertised.includes(modelId) ? modelId : undefined;
}
