import { describe, expect, it, vi } from 'vitest';
import { customModelOptionId } from '@gugu/session-core/models/custom-model';
import { codexApiKeyConnectionArgs } from './harness-connection-launch';
import { codexChannelSwitchNeedsNewThread } from './codex-channel-switch';

const relay = 'https://relay.example.test/v1';
const official = 'https://api.openai.com/v1';
const custom = { kind: 'custom', connectionId: '11111111-1111-4111-8111-111111111111', modelId: 'gpt-a' } as const;
const next = customModelOptionId({ connectionId: '22222222-2222-4222-8222-222222222222', modelId: 'gpt-b' });

describe('Codex channel switch', () => {
  it.each([
    [true, undefined, 'own', next, relay, false],
    [false, custom, 'platform', 'gugu-model', relay, false],
    [false, custom, 'own', next, relay, false],
    [true, undefined, 'own', next, official, true],
    [false, custom, 'own', next, official, true],
    [false, custom, 'own', customModelOptionId({ ...custom, modelId: 'gpt-c' }), official, false],
    [true, undefined, 'own', null, relay, true],
    [false, undefined, 'platform', 'gugu-model', relay, true],
    [false, custom, 'own', 'native-model', relay, true],
    [false, undefined, 'own', next, relay, true],
    [false, undefined, 'own', 'native-model', relay, false],
  ] as const)('uses the expected thread for %s / %j → %s %s (%s)', async (previousPlatform, previousCustom, target, targetModel, endpoint, fork) => {
    const customEndpoint = vi.fn(async () => endpoint);
    await expect(codexChannelSwitchNeedsNewThread({ previousPlatform, previousCustom, target, targetModel, customEndpoint })).resolves.toBe(fork);
  });

  it('defines the same current endpoint under the shared and legacy provider keys for a relay', () => {
    const loopback = 'http://127.0.0.1:4111/v1';
    const args = codexApiKeyConnectionArgs('My relay', loopback, relay, 'gpt-b');
    expect(args.filter((arg) => arg.startsWith('model_provider='))).toEqual(['model_provider="gugu_platform"']);
    for (const id of ['gugu_platform', 'gugu_connection']) {
      expect(args).toContain(`model_providers.${id}.base_url="${loopback}"`);
      expect(args).toContain(`model_providers.${id}.env_key="OPENAI_API_KEY"`);
    }
    expect(codexApiKeyConnectionArgs('OpenAI', loopback, official)).toContain('model_provider="gugu_connection"');
  });
});
