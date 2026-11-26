import { describe, expect, it } from 'vitest';
import type { CustomModelConnection } from '@gugu/session-core/models/custom-model';
import { customModelFastSupported, draftFastMode, sessionFastMode } from './fast-mode';

const connection = (protocol: CustomModelConnection['endpoints'][number]['protocol'], fast = true): Pick<CustomModelConnection, 'endpoints' | 'keySaved' | 'harnessProtocols' | 'routes' | 'models'> => ({
  keySaved: true, endpoints: [{ protocol, baseUrl: 'https://provider.test/v1' }], models: [{ id: 'm', ...(fast ? { fast } : {}) }],
});
const agent = (protocols: CustomModelConnection['endpoints'][number]['protocol'][], convertFrom: typeof protocols = []) =>
  ({ id: 'harness', capabilities: { modelProtocols: protocols, customModel: { convertFrom } } });

describe('custom model Fast', () => {
  it('is offered only for a model that declares it, reached directly over an OpenAI Chat or Responses address', () => {
    expect(customModelFastSupported(connection('openai-responses'), 'm', agent(['openai-responses']))).toBe(true);
    expect(customModelFastSupported(connection('openai-chat-completions'), 'm', agent(['openai-chat-completions']))).toBe(true);
    expect(customModelFastSupported(connection('openai-responses', false), 'm', agent(['openai-responses']))).toBe(false);
    expect(customModelFastSupported(connection('anthropic-messages'), 'm', agent(['anthropic-messages']))).toBe(false);
    // Converted through the bundled router: one shared key per record, so no session can be told apart.
    expect(customModelFastSupported(connection('openai-responses'), 'm', agent(['anthropic-messages'], ['openai-responses']))).toBe(false);
    expect(customModelFastSupported(undefined, 'm', agent(['openai-responses']))).toBe(false);
  });

  it('shows the session record on a custom session and leaves every other session to its own rule', () => {
    const base = { capabilities: null, route: 'own' as const, group: null };
    expect(sessionFastMode({ ...base, customSupported: true, recorded: true })).toBe(true);
    expect(sessionFastMode({ ...base, customSupported: true })).toBe(false);
    expect(sessionFastMode({ ...base, customSupported: false, recorded: true })).toBeUndefined();
    expect(sessionFastMode(base)).toBeUndefined();
    const draft = { enabled: true, capabilities: null, modelId: null, platformModel: null, catalog: { kind: 'idle' } };
    expect(draftFastMode({ ...draft, customSupported: true })).toBe(true);
    expect(draftFastMode({ ...draft, customSupported: false })).toBeUndefined();
    expect(draftFastMode(draft)).toBeUndefined();
  });
});
