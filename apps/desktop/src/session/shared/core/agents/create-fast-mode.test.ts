import { pluginRegistry } from '@gugu/session-plugins/agents';
import { describe, expect, it } from 'vitest';
import { creationFastGroup } from './create-fast-mode';

const fastMode = { configId: 'fast', selected: 'off', available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] };
const ready = { kind: 'ready', selected: 'native-model', fastMode };
const capabilities = pluginRegistry.get('codex')!.capabilities;
describe('native Fast for mobile creation', () => {
  it.each(['codex', 'claude'])('returns the advertised %s group for its exact target', provider => {
    expect(creationFastGroup(pluginRegistry.get(provider)?.capabilities, 'native-model', ready)).toEqual({ model: 'native-model', selected: 'off', available: fastMode.available });
  });
  it.each([null, 'another-model', 'platform:paid'])('rejects an unproven or platform target %s', model => {
    expect(creationFastGroup(capabilities, model, ready)).toBeNull();
  });
  it.each(['unknown', 'auth-required', 'unavailable'])('rejects a %s snapshot', kind => {
    expect(creationFastGroup(capabilities, 'native-model', { ...ready, kind })).toBeNull();
  });
  it.each(['pi', 'gemini', 'missing'])('requires the provider opt-in: %s', provider => {
    expect(creationFastGroup(pluginRegistry.get(provider)?.capabilities, 'native-model', ready)).toBeNull();
  });
  it.each([
    undefined, { ...fastMode, configId: 'other' }, { ...fastMode, selected: 'unknown' },
    { ...fastMode, available: [] }, { ...fastMode, available: [fastMode.available[0]!] },
  ])('rejects a missing or malformed native on/off group %j', group => {
    expect(creationFastGroup(capabilities, 'native-model', { ...ready, fastMode: group })).toBeNull();
  });
});
