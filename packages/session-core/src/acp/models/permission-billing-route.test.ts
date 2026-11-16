import { describe, expect, it } from 'vitest';
import { permissionModeSupportsBillingRoute, type ProviderPermissionModeMap } from './permissions';

const modes = {
  edit: { id: ':workspace' },
  'ai-review': { id: 'auto-review', billingRoutes: ['own'] },
} satisfies ProviderPermissionModeMap;

describe('permission billing route admission', () => {
  it.each(['own', 'platform', 'unknown'] as const)('keeps ordinary tiers on %s', route => {
    expect(permissionModeSupportsBillingRoute('edit', modes, route)).toBe(true);
  });
  it('requires an explicit own route for an own-account reviewer', () => {
    expect(permissionModeSupportsBillingRoute('ai-review', modes, 'own')).toBe(true);
    expect(permissionModeSupportsBillingRoute('ai-review', modes, 'platform')).toBe(false);
    expect(permissionModeSupportsBillingRoute('ai-review', modes, 'unknown')).toBe(false);
  });
  it('does not restrict another provider without a declared route requirement', () => {
    expect(permissionModeSupportsBillingRoute('ai-review', { 'ai-review': { id: 'auto' } }, 'platform')).toBe(true);
  });
});
