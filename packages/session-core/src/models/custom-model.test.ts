import { describe, expect, it } from 'vitest';
import { customModelMetaSchema, customModelOptionId, customModelRefFromOption, customModelRuntimeOption, matchCustomModel, modelEndpointSchema, normalizeModelBaseUrl, runtimeModelId, sessionModelSelectionSchema } from './custom-model';
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
