import { describe, expect, it } from 'vitest';
import { buildSessionPermissionOptions } from './session-permission-options';
import { catalogAllowsAutoReview, type ProviderPermissionModeMap } from '@gugu/session-core/acp/client';

const map: ProviderPermissionModeMap = {
  plan: { id: 'plan' }, 'read-only': { id: 'default' }, edit: { id: 'acceptEdits' },
  'ai-review': { id: 'auto', reviewRequirements: { minimumCliVersion: '2.1.302', modelPattern: '^opus$' } },
  'full-access': { id: 'bypassPermissions' },
};
const native = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'].map(id => ({ id, name: id }));
const expected = native.map(({ id }) => id);

describe('one permission menu source', () => {
  it.each(['running', 'stopped', 'disconnected'])('keeps the complete qualified menu for %s sessions', () => {
    const catalog = { kind: 'ready', selected: 'opus', cliVersion: '2.1.322', autoReview: true };
    const group = buildSessionPermissionOptions({ modeMap: map, native,
      review: { allowed: catalogAllowsAutoReview(map, catalog, 'own', 'opus') } });
    expect(group?.available.map(choice => choice.id)).toEqual(expected);
    expect(group?.available.find(choice => choice.id === 'auto')?.disabled).toBeUndefined();
  });
  it.each([
    { kind: 'ready', selected: 'opus', cliVersion: '2.1.301', autoReview: true },
    { kind: 'ready', selected: 'opus', cliVersion: '2.1.322', autoReview: false },
    { kind: 'ready', selected: 'sonnet', cliVersion: '2.1.322', autoReview: true },
    { kind: 'unknown' },
  ])('keeps an unavailable row without bypassing admission: %j', catalog => {
    const group = buildSessionPermissionOptions({ modeMap: map, native,
      review: { allowed: catalogAllowsAutoReview(map, catalog, 'own', 'opus'), reason: 'blocked' } });
    expect(group?.available.map(choice => choice.id)).toEqual(expected);
    expect(group?.available.find(choice => choice.id === 'auto')).toMatchObject({ disabled: true, description: 'blocked' });
  });
  it('requires both native advertisement and positive reviewer admission', () => {
    const group = buildSessionPermissionOptions({ modeMap: map, native: native.filter(choice => choice.id !== 'auto'), review: { allowed: true } });
    expect(group?.available.find(choice => choice.id === 'auto')).toMatchObject({ disabled: true });
  });
  it('keeps unknown eligibility visible with a reason', () => {
    const group = buildSessionPermissionOptions({ modeMap: map });
    expect(group?.available.map(choice => choice.id)).toEqual(expected);
    expect(group?.available.find(choice => choice.id === 'auto')).toMatchObject({ disabled: true, description: 'taskConfig.reviewEligibilityUnknown' });
  });
  it('does not invent a permission tier absent from the provider declaration', () => {
    expect(buildSessionPermissionOptions({ modeMap: { edit: { id: 'build' } } })?.available.map(choice => choice.id)).toEqual(['build']);
  });
});
