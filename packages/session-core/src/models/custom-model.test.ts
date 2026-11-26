import { describe, expect, it } from 'vitest';
import { chatModel, customModelAcceptsImages, customModelCatalogLevels, customModelDefaultEffort, customModelEfforts, customModelEntrySchema, customModelMetaSchema, proposedDefaultEffort, customModelOptionId, customModelRefFromOption, customModelRuntimeOption, detectModelProtocol, matchCustomModel, modelEndpointSchema, normalizeModelBaseUrl, runtimeModelId, sessionModelSelectionSchema } from './custom-model';
import { providerPresets } from './provider-presets';

const connectionId = '481825a8-60b9-4c83-8d1b-f104e3db0269';
describe('custom model identity and metadata', () => {
  it.each(['qwen:7b', 'provider/model', '', 'a:b:c'])('roundtrips the entire model ID %j', (modelId) => {
    const encoded = customModelOptionId({ connectionId, modelId });
    expect(customModelRefFromOption(encoded)).toEqual({ kind: 'custom', connectionId, ...(modelId ? { modelId } : {}) });
    expect(runtimeModelId(encoded)).toBe(modelId || undefined);
  });
  it.each(['custom:model', 'custom:not-a-uuid:model', 'custom:481825a8-60b9-4c83-8d1b-f104e3db0269', `CUSTOM:${connectionId}:model`, 'custom-model'])('leaves malformed references native: %s', (id) => {
    expect(customModelRefFromOption(id)).toBeNull();
    expect(runtimeModelId(id)).toBe(id);
  });
  it('validates native, platform and custom choices, including CLI defaults', () => {
    for (const selection of [{ kind: 'native' }, { kind: 'platform', modelId: 'm' }, { kind: 'custom', connectionId }]) {
      expect(sessionModelSelectionSchema.safeParse(selection).success).toBe(true);
    }
    expect(sessionModelSelectionSchema.safeParse({ kind: 'custom', connectionId: 'not-uuid' }).success).toBe(false);
  });
  it('allows migrated empty model lists and rejects duplicate IDs and protocols', () => {
    const meta = { preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://example.test/v1' }], models: [] };
    expect(customModelMetaSchema.safeParse(meta).success).toBe(true);
    expect(customModelMetaSchema.safeParse({ ...meta, endpoints: [...meta.endpoints, ...meta.endpoints] }).success).toBe(false);
    expect(customModelMetaSchema.safeParse({ ...meta, models: [{ id: 'm' }, { id: 'm' }] }).success).toBe(false);
  });
  it.each([
    ['https://example.test/v1/chat/completions', 'https://example.test/v1'],
    ['https://example.test/api/responses/', 'https://example.test/api'],
    ['https://example.test/anthropic/v1/messages', 'https://example.test/anthropic'],
    ['http://127.0.0.1:4021', 'http://127.0.0.1:4021'],
  ])('normalizes %s without inventing a version path', (input, expected) => expect(normalizeModelBaseUrl(input)).toBe(expected));
  it.each(['https://user:secret@example.test', 'file:///tmp/provider', 'https://example.test?key=secret'])('rejects unsafe roots without throwing from safeParse', (baseUrl) => {
    expect(modelEndpointSchema.safeParse({ protocol: 'openai-responses', baseUrl }).success).toBe(false);
  });
  it('resolves a live model only inside the reported provider addressing', () => {
    const ref = { kind: 'custom' as const, connectionId, modelId: 'm1' };
    expect(customModelRuntimeOption(ref, 'm2', 'provider/m1', ['provider/m1', 'provider/m2', 'other/m2'])).toBe('provider/m2');
    expect(customModelRuntimeOption(ref, 'm2', 'provider/m1', ['other/m2'])).toBeUndefined();
  });
});

describe('custom model protocol matching', () => {
  it('uses the first rule matching both model and incoming protocol, including its separate address', () => {
    const anthropic = { protocol: 'anthropic-messages', baseUrl: 'https://relay.test' } as const;
    const chat = { protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' } as const;
    const override = { id: '004e3794-4df0-4598-b438-4967e139ea12', incoming: 'anthropic-messages',
      outgoing: chat.protocol, modelId: 'special', baseUrl: 'https://relay.test/compatible' } as const;
    const fallback = { id: '31ba430b-ad77-4405-9d62-9202fe6adb4a', incoming: 'any', outgoing: anthropic.protocol } as const;
    const input = {
      nativeProtocol: anthropic.protocol, convertFrom: [chat.protocol], modelId: 'special',
      connection: { endpoints: [anthropic, chat], keySaved: true, routes: [override, fallback] },
    };
    expect(matchCustomModel(input)).toEqual({ routeId: override.id, converted: true,
      endpoint: { protocol: chat.protocol, baseUrl: override.baseUrl } });
    expect(matchCustomModel({ ...input, modelId: 'other' })).toEqual({ routeId: fallback.id, endpoint: anthropic });
    expect(matchCustomModel({ ...input, connection: { ...input.connection, routes: [fallback, override] } }))
      .toEqual({ routeId: fallback.id, endpoint: anthropic });
    expect(matchCustomModel({ ...input, nativeProtocol: chat.protocol }).reason).toBe('protocol');
  });
  it('prefers native protocol regardless of endpoint order', () => {
    const endpoints = [{ protocol: 'openai-chat-completions' as const, baseUrl: 'https://chat.test' }, { protocol: 'openai-responses' as const, baseUrl: 'https://responses.test' }];
    expect(matchCustomModel({ nativeProtocol: 'openai-responses', protocols: ['openai-chat-completions'], connection: { endpoints, keySaved: true } }).endpoint).toEqual(endpoints[1]);
  });
  it('distinguishes unsupported, protocol, missing-key and missing-model failures', () => {
    const connection = { endpoints: [{ protocol: 'anthropic-messages' as const, baseUrl: 'https://a.test' }], keySaved: false };
    expect(matchCustomModel({ connection }).reason).toBe('unsupported');
    expect(matchCustomModel({ connection, nativeProtocol: 'openai-responses' }).reason).toBe('protocol');
    expect(matchCustomModel({ connection, nativeProtocol: 'anthropic-messages' }).reason).toBe('missing-key');
    expect(matchCustomModel({ connection: { ...connection, keySaved: true }, nativeProtocol: 'anthropic-messages', hasModel: false }).reason).toBe('no-model');
    expect(matchCustomModel({ connection: { ...connection, keySaved: true }, nativeProtocol: 'anthropic-messages', hasModel: false, allowDefaultModel: true }).reason).toBeUndefined();
  });
  it('offers a protocol the harness can convert only when no direct endpoint matches', () => {
    const chat = { protocol: 'openai-chat-completions' as const, baseUrl: 'https://chat.test/v1' };
    const anthropic = { protocol: 'anthropic-messages' as const, baseUrl: 'https://a.test' };
    const convertible = { nativeProtocol: 'anthropic-messages' as const, convertFrom: ['openai-chat-completions' as const] };
    expect(matchCustomModel({ ...convertible, connection: { endpoints: [chat], keySaved: true } })).toEqual({ endpoint: chat, converted: true });
    expect(matchCustomModel({ ...convertible, connection: { endpoints: [chat, anthropic], keySaved: true } })).toEqual({ endpoint: anthropic });
    expect(matchCustomModel({ nativeProtocol: 'anthropic-messages', connection: { endpoints: [chat], keySaved: true } }).reason).toBe('protocol');
    expect(matchCustomModel({ ...convertible, connection: { endpoints: [{ ...chat, protocol: 'gemini-generate-content' as const }], keySaved: true } }).reason).toBe('protocol');
    expect(matchCustomModel({ ...convertible, connection: { endpoints: [chat], keySaved: false } }).reason).toBe('missing-key');
  });
  it('takes the protocol the person picked for this harness when the harness can use it', () => {
    const chat = { protocol: 'openai-chat-completions' as const, baseUrl: 'https://chat.test/v1' };
    const anthropic = { protocol: 'anthropic-messages' as const, baseUrl: 'https://a.test' };
    const claude = { harness: 'claude', nativeProtocol: 'anthropic-messages' as const, convertFrom: ['openai-chat-completions' as const] };
    expect(matchCustomModel({ ...claude, connection: { endpoints: [anthropic, chat], keySaved: true, harnessProtocols: { claude: 'openai-chat-completions' } } })).toEqual({ endpoint: chat, converted: true });
    expect(matchCustomModel({ ...claude, connection: { endpoints: [anthropic, chat], keySaved: true, harnessProtocols: { codex: 'openai-chat-completions' } } })).toEqual({ endpoint: anthropic });
    expect(matchCustomModel({ ...claude, connection: { endpoints: [anthropic], keySaved: true, harnessProtocols: { claude: 'openai-chat-completions' } } })).toEqual({ endpoint: anthropic });
    expect(matchCustomModel({ ...claude, connection: { endpoints: [anthropic, chat], keySaved: true, harnessProtocols: { claude: 'gemini-generate-content' } } })).toEqual({ endpoint: anthropic });
  });
  it.each([
    ['https://open.bigmodel.cn/api/anthropic', 'anthropic-messages'],
    ['https://api.deepseek.com/anthropic/v1', 'anthropic-messages'],
    ['https://api.anthropic.com', 'anthropic-messages'],
    ['https://api.anthropic.com/v1', 'anthropic-messages'],
    ['https://relay.test/v1/messages', 'anthropic-messages'],
    ['https://api.openai.com/v1/responses', 'openai-responses'],
    ['https://api.siliconflow.cn/v1/chat/completions', 'openai-chat-completions'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'openai-chat-completions'],
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini-generate-content'],
    ['https://api.siliconflow.cn/v1', undefined],
    ['https://relay.test', undefined],
    ['not a url', undefined],
  ])('recognizes the protocol an address names: %s', (address, protocol) => {
    expect(detectModelProtocol(address)).toBe(protocol);
  });
});

it('every preset endpoint has an official source and no frozen model list', () => {
  expect(providerPresets).toHaveLength(12);
  expect(new Set(providerPresets.map(({ id }) => id)).size).toBe(12);
  for (const preset of providerPresets) {
    expect(preset.endpoints.length, preset.id).toBeGreaterThan(0);
    for (const endpoint of preset.endpoints) {
      expect(new URL(endpoint.source).protocol).toBe('https:');
      expect(preset.sources).toContain(endpoint.source);
      expect(modelEndpointSchema.safeParse(endpoint).success, preset.id).toBe(true);
    }
    expect(preset).not.toHaveProperty('models');
  }
});

describe('custom model image input', () => {
  it('refuses images only when the person declared the model text-only', () => {
    // A relay model found in Codex config or a model list carries no image fact at all.
    expect(customModelAcceptsImages({})).toBe(true);
    expect(customModelAcceptsImages(undefined)).toBe(true);
    expect(customModelAcceptsImages({ image: true })).toBe(true);
    expect(customModelAcceptsImages({ image: false })).toBe(false);
  });
});

describe('relay model lists', () => {
  it('offers only chat models: metadata first, then known non-chat families by id', () => {
    const listed = [
      { id: 'gpt-5.5-relay' }, { id: 'deepseek-v4', supported_endpoint_types: ['openai'] },
      { id: 'doubao-seedance-2-0-260128' }, { id: 'doubao-seedream-5-0' }, { id: 'text-embedding-3-large' },
      { id: 'veo-4', supported_endpoint_types: ['openai-video'] }, { id: 'custom-rerank', supported_endpoint_types: ['jina-rerank'] },
      { id: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { id: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
    ];
    expect(listed.filter(chatModel).map(({ id }) => id)).toEqual(['gpt-5.5-relay', 'deepseek-v4', 'models/gemini-3-pro']);
  });
});

describe('custom model thinking levels', () => {
  const harness = { kind: 'selectable', effortOptions: { default: {}, low: {}, medium: {}, high: {} } };
  const effortCatalog = { kind: 'found' as const, catalogId: 'example/thinking', name: 'Thinking', efforts: ['default', 'high', 'max'] };
  it('offers only explicit levels supported by the matched model and the harness', () => {
    expect(customModelEfforts({ effortCatalog }, harness)).toEqual(['high']);
    expect(customModelEfforts({ effortCatalog }, { kind: 'none' })).toBeNull();
  });
  it('does not guess levels for an unknown or non-thinking model', () => {
    expect(customModelEfforts({}, harness)).toBeNull();
    expect(customModelEfforts({ effortCatalog: { kind: 'not-found' } }, harness)).toBeNull();
    expect(customModelEfforts({ effortCatalog: { kind: 'unavailable' } }, harness)).toBeNull();
    expect(customModelEfforts({ effortCatalog: { ...effortCatalog, efforts: [] } }, harness)).toBeNull();
  });
  it('takes the levels the person checked over the catalog, and none while thinking is off', () => {
    expect(customModelEfforts({ effortCatalog, efforts: ['low', 'medium', 'xhigh'] }, harness)).toEqual(['low', 'medium']);
    expect(customModelEfforts({ effortCatalog, efforts: [] }, harness)).toBeNull();
    expect(customModelEfforts({ effortCatalog, thinking: false }, harness)).toBeNull();
    expect(customModelEfforts({ efforts: ['high'], thinking: false }, harness)).toBeNull();
  });
  it('starts a session on the chosen default only when the harness offers it', () => {
    expect(customModelDefaultEffort({ defaultEffort: 'high' }, ['low', 'high'])).toBe('high');
    expect(customModelDefaultEffort({ defaultEffort: 'max' }, ['low', 'high'])).toBeUndefined();
    expect(customModelDefaultEffort({}, ['low', 'high'])).toBeUndefined();
    expect(customModelDefaultEffort({ defaultEffort: 'high' }, null)).toBeUndefined();
  });
  it('checks the catalog levels the dialog lists and proposes High, else the highest checked', () => {
    expect(customModelCatalogLevels(effortCatalog)).toEqual(['high', 'max']);
    expect(customModelCatalogLevels({ kind: 'not-found' })).toEqual([]);
    expect(customModelCatalogLevels(undefined)).toEqual([]);
    expect(proposedDefaultEffort(['low', 'medium', 'high', 'max'])).toBe('high');
    expect(proposedDefaultEffort(['low', 'medium'])).toBe('medium');
    expect(proposedDefaultEffort(['xhigh', 'low'])).toBe('xhigh');
    expect(proposedDefaultEffort([])).toBeUndefined();
  });
  it('stores the declared capabilities and rejects a level the dialog does not offer', () => {
    const declared = { id: 'm', toolCall: false, thinkingOnly: true, thinkingOptional: false, fast: true, efforts: ['low', 'high'], defaultEffort: 'high' };
    expect(customModelEntrySchema.parse(declared)).toEqual(declared);
    expect(customModelEntrySchema.safeParse({ id: 'm', efforts: ['ultra'] }).success).toBe(false);
    expect(customModelEntrySchema.safeParse({ id: 'm', defaultEffort: 'default' }).success).toBe(false);
  });
});
