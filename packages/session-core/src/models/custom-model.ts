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

/** The thinking levels a person can declare for a custom model, lowest first. */
export const CUSTOM_MODEL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const customModelEffortLevelSchema = z.enum(CUSTOM_MODEL_EFFORT_LEVELS);
export type CustomModelEffortLevel = z.infer<typeof customModelEffortLevelSchema>;

export const customModelEntrySchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().max(200).optional(),
  image: z.boolean().optional(),
  /** Thinking mode. Off: the model is offered no thinking levels. */
  thinking: z.boolean().optional(),
  /**
   * What the person declared about tool calling and whether thinking can be switched off. Stored and shown again;
   * no harness reads them yet.
   */
  toolCall: z.boolean().optional(),
  thinkingOnly: z.boolean().optional(),
  thinkingOptional: z.boolean().optional(),
  /** The provider takes `service_tier: "priority"`; only an OpenAI Chat or Responses address can. */
  fast: z.boolean().optional(),
  /** The levels the person checked. Present (even empty) wins over the models.dev catalog. */
  efforts: z.array(customModelEffortLevelSchema).max(CUSTOM_MODEL_EFFORT_LEVELS.length).optional(),
  /** The level a new session starts on; absent = the request carries none. */
  defaultEffort: customModelEffortLevelSchema.optional(),
  /** An explicitly selected models.dev ID for a relay ID that cannot be resolved directly. */
  modelsDevId: z.string().trim().min(1).max(200).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutput: z.number().int().positive().optional(),
});

const modelsDevChoiceSchema = z.object({ catalogId: z.string(), name: z.string() });
export const customModelEffortResultSchema = z.discriminatedUnion('kind', [
  modelsDevChoiceSchema.extend({ kind: z.literal('found'), efforts: z.array(z.string()) }),
  z.object({ kind: z.literal('ambiguous'), candidates: z.array(modelsDevChoiceSchema) }),
  z.object({ kind: z.literal('not-found') }),
  z.object({ kind: z.literal('unavailable') }),
]);
export type CustomModelEffortResult = z.infer<typeof customModelEffortResultSchema>;
const customModelViewSchema = customModelEntrySchema.extend({ effortCatalog: customModelEffortResultSchema.optional() });

export const customModelRouteSchema = z.object({
  id: z.string().uuid(),
  incoming: z.union([z.literal('any'), modelProtocolSchema]),
  outgoing: modelProtocolSchema,
  modelId: z.string().trim().min(1).max(200).optional(),
  baseUrl: modelEndpointSchema.shape.baseUrl.optional(),
});
export type CustomModelRoute = z.infer<typeof customModelRouteSchema>;

export const customModelMetaSchema = z.object({
  preset: z.string().nullable(),
  endpoints: z.array(modelEndpointSchema).min(1).max(4)
    .refine((entries) => new Set(entries.map(({ protocol }) => protocol)).size === entries.length, 'Use one address per protocol'),
  models: z.array(customModelEntrySchema).max(200)
    .refine((entries) => new Set(entries.map(({ id }) => id)).size === entries.length, 'Model IDs must be unique'),
  routes: z.array(customModelRouteSchema).max(100)
    .refine((routes) => new Set(routes.map(({ id }) => id)).size === routes.length, 'Route IDs must be unique').optional(),
  /** The protocol the person picked for a harness (harness id → protocol); a harness not named here takes `matchCustomModel`'s order. */
  harnessProtocols: z.record(z.string(), modelProtocolSchema).optional(),
  removed: z.boolean().optional(),
});
export type CustomModelMeta = z.infer<typeof customModelMetaSchema>;
export type CustomModelEntry = z.infer<typeof customModelViewSchema>;

/**
 * Whether a custom model takes image input. Only the person can say a model doesn't: no model list or Codex config
 * carries the fact, so an undeclared model is not refused here and the provider answers for itself.
 */
export function customModelAcceptsImages(entry: Pick<CustomModelEntry, 'image'> | undefined): boolean {
  return entry?.image !== false;
}

/**
 * Whether a custom model the person has not switched either way gets thinking levels. The one place the default lives.
 * On: a relay rarely says, and its first level, "Default", sends no level at all, so a model without one is not refused.
 */
export const CUSTOM_MODEL_THINKING_DEFAULT = true;

export function customModelThinks(entry: Pick<CustomModelEntry, 'thinking'> | undefined): boolean {
  return entry?.thinking ?? CUSTOM_MODEL_THINKING_DEFAULT;
}

/**
 * The levels a session on this model can choose: the ones the person checked, else the matched catalog entry's, kept
 * to those the harness can send. None while thinking is off.
 */
export function customModelEfforts(
  entry: Pick<CustomModelEntry, 'effortCatalog' | 'efforts' | 'thinking'> | undefined,
  harnessEffort: { kind: string; effortOptions?: Record<string, unknown> } | undefined,
): string[] | null {
  const catalog = entry?.effortCatalog;
  const options = harnessEffort?.kind === 'selectable' ? harnessEffort.effortOptions : undefined;
  if (!options || !customModelThinks(entry)) return null;
  const declared = entry?.efforts ?? (catalog?.kind === 'found' ? catalog.efforts : null);
  const levels = declared?.filter((id) => id.toLowerCase() !== 'default' && Object.hasOwn(options, id)) ?? [];
  return levels.length ? levels : null;
}

/** The level a new session on this model starts on, when the person chose one this harness offers. */
export function customModelDefaultEffort(
  entry: Pick<CustomModelEntry, 'defaultEffort'> | undefined,
  levels: readonly string[] | null,
): string | undefined {
  return entry?.defaultEffort && levels?.includes(entry.defaultEffort) ? entry.defaultEffort : undefined;
}

/** The protocols whose requests can carry `service_tier`. */
export const FAST_PROTOCOLS: readonly ModelProtocol[] = ['openai-chat-completions', 'openai-responses'];

/** The catalog's levels the dialog can check. */
export function customModelCatalogLevels(result: CustomModelEffortResult | undefined): CustomModelEffortLevel[] {
  if (result?.kind !== 'found') return [];
  return CUSTOM_MODEL_EFFORT_LEVELS.filter((level) => result.efforts.includes(level));
}

/** The default a set of checked levels proposes: High when checked, else the highest one; none = automatic. */
export function proposedDefaultEffort(levels: readonly CustomModelEffortLevel[]): CustomModelEffortLevel | undefined {
  if (levels.includes('high')) return 'high';
  return [...CUSTOM_MODEL_EFFORT_LEVELS].reverse().find((level) => levels.includes(level));
}

const NON_CHAT_MODEL = /embed|rerank|moderation|whisper|tts|speech|transcri|audio|realtime|dall-e|image|seedream|seedance|video|sora|veo|kling|hailuo/i;
const CHAT_ENDPOINT_TYPES = new Set(['openai', 'openai-response', 'anthropic', 'gemini']);

/**
 * Whether a relay's model is one a harness can chat with. Metadata the entry carries wins (Gemini's
 * `supportedGenerationMethods`, a relay's `supported_endpoint_types`); otherwise the id names a known non-chat family.
 */
export function chatModel(entry: { id: string; supportedGenerationMethods?: unknown; supported_endpoint_types?: unknown }): boolean {
  const methods = entry.supportedGenerationMethods;
  if (Array.isArray(methods) && !methods.includes('generateContent')) return false;
  const types = entry.supported_endpoint_types;
  if (Array.isArray(types) && types.length > 0 && !types.some((type) => CHAT_ENDPOINT_TYPES.has(type))) return false;
  return !NON_CHAT_MODEL.test(entry.id);
}

export type PiCustomModelProvider = {
  connectionId: string;
  routeId?: string;
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
  models: z.array(customModelViewSchema),
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
 * The protocol the person picked for this harness wins when the harness can use it; otherwise native protocol, then the
 * writer's other explicitly supported protocols, then a protocol the harness declares the bundled local router can
 * convert (`converted: true`).
 */
export function matchCustomModel(input: {
  harness?: string;
  nativeProtocol?: HarnessWireProtocol;
  protocols?: readonly HarnessWireProtocol[];
  convertFrom?: readonly HarnessWireProtocol[];
  allowDefaultModel?: boolean;
  hasModel?: boolean;
  modelId?: string;
  connection: Pick<CustomModelConnection, 'endpoints' | 'keySaved' | 'harnessProtocols' | 'routes'>;
}): { endpoint: CustomModelMeta['endpoints'][number]; routeId?: string; converted?: true; reason?: never } | { endpoint?: never; routeId?: never; converted?: never; reason: CustomModelUnavailableReason } {
  if (!input.nativeProtocol) return { reason: 'unsupported' };
  const direct = [input.nativeProtocol, ...(input.protocols ?? [])];
  const convertible = input.convertFrom ?? [];
  const find = (protocols: readonly HarnessWireProtocol[]) =>
    protocols.map((protocol) => input.connection.endpoints.find((item) => item.protocol === protocol)).find(Boolean);
  const routes = input.connection.routes;
  const route = routes?.find(({ incoming, modelId }) =>
    (incoming === 'any' || incoming === input.nativeProtocol) && (modelId === undefined || modelId === input.modelId));
  let endpoint: CustomModelMeta['endpoints'][number] | undefined;
  if (routes?.length) {
    if (route && [...direct, ...convertible].includes(route.outgoing)) {
      endpoint = route.baseUrl ? { protocol: route.outgoing, baseUrl: route.baseUrl } : find([route.outgoing]);
    }
  } else {
    const chosen = input.harness ? input.connection.harnessProtocols?.[input.harness] : undefined;
    endpoint = (chosen && [...direct, ...convertible].includes(chosen) ? find([chosen]) : undefined)
      ?? find(direct) ?? find(convertible);
  }
  if (!endpoint) return { reason: 'protocol' };
  if (!input.connection.keySaved) return { reason: 'missing-key' };
  if (input.hasModel === false && !input.allowDefaultModel) return { reason: 'no-model' };
  return {
    endpoint,
    ...(route ? { routeId: route.id } : {}),
    ...(direct.includes(endpoint.protocol) ? {} : { converted: true }),
  };
}

/** Resolve only within the provider addressing reported by this running custom session. */
export function customModelRuntimeOption(ref: CustomModelRef, modelId: string, selected: string | null | undefined, advertised: readonly string[]): string | undefined {
  if (ref.modelId && selected?.endsWith(`/${ref.modelId}`)) {
    const candidate = selected.slice(0, -ref.modelId.length) + modelId;
    return advertised.includes(candidate) ? candidate : undefined;
  }
  return advertised.includes(modelId) ? modelId : undefined;
}
