import { pluginRegistry } from '@gugu/session-plugins/agents';
import { describe, expect, it } from 'vitest';
import { draftFastMode, fastModeValue, sessionFastMode } from './fast-mode';

const capabilitiesFor = (id?: string) => id ? pluginRegistry.get(id)?.capabilities : undefined;

const native = { configId: 'fast', selected: 'off', available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] };

describe('Fast capability for the composer', () => {
  it.each(['codex', 'claude'])('shows a native %s option only on an explicit own route', providerId => {
    expect(sessionFastMode({ capabilities: capabilitiesFor(providerId), route: 'own', group: native })).toBe(false);
    expect(sessionFastMode({ capabilities: capabilitiesFor(providerId), route: 'own', group: { ...native, selected: 'on' } })).toBe(true);
  });
  it.each(['platform', 'unknown'] as const)('hides the native group on the %s route', route => {
    expect(sessionFastMode({ capabilities: capabilitiesFor('codex'), route, group: native })).toBeUndefined();
  });
  it.each(['pi', 'gemini', undefined])('hides an ineligible harness %s', providerId => {
    expect(sessionFastMode({ capabilities: capabilitiesFor(providerId), route: 'own', group: native })).toBeUndefined();
  });
  it('does not confuse another on/off config with native Fast', () => {
    expect(sessionFastMode({ capabilities: capabilitiesFor('codex'), route: 'own', group: { ...native, configId: 'other' } })).toBeUndefined();
  });
  it.each([null, undefined, { ...native, available: [] }, { ...native, available: [native.available[0]!] }, { ...native, selected: 'unknown' }])('hides missing or malformed host capability %j', group => {
    expect(fastModeValue(group)).toBeUndefined();
  });
  it('defaults an unselected supported group to off', () => {
    expect(fastModeValue({ ...native, selected: null })).toBe(false);
  });
  it('keeps a new draft off even when the vendor global setting is on', () => {
    expect(draftFastMode({ enabled: false, capabilities: capabilitiesFor('codex'), modelId: 'native-model', platformModel: null,
      catalog: { kind: 'ready', selected: 'native-model', fastMode: { ...native, selected: 'on' } } })).toBe(false);
  });
  it('carries explicit draft intent only for the model the probe actually selected', () => {
    const input = { enabled: true, capabilities: capabilitiesFor('claude'), modelId: 'native-model', platformModel: null,
      catalog: { kind: 'ready', selected: 'native-model', fastMode: native } };
    expect(draftFastMode(input)).toBe(true);
    expect(draftFastMode({ ...input, modelId: 'another-model' })).toBeUndefined();
    expect(draftFastMode({ ...input, platformModel: 'paid-with-credits' })).toBeUndefined();
    expect(draftFastMode({ ...input, catalog: { kind: 'unknown' } })).toBeUndefined();
  });
});
