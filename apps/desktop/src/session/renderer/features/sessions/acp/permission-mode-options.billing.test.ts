import { describe, expect, it } from 'vitest';
import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import { sessionPermissionModeOptions } from './permission-mode-options';

const modeMap: ProviderPermissionModeMap = {
  edit: { id: ':workspace' },
  'ai-review': { id: 'auto-review', billingRoutes: ['own'], aliases: ['native-review'] },
};
const options = { ':workspace': { name: 'Edit' }, 'auto-review': { name: 'AI review' }, 'native-review': { name: 'Alias' } };

describe('permission selector billing route', () => {
  it.each(['platform', 'unknown'] as const)('hides the unavailable reviewer on %s, including aliases', route => {
    expect(sessionPermissionModeOptions(options, undefined, undefined, { route, modeMap })).toEqual({ ':workspace': options[':workspace'] });
    expect(options['auto-review']).toBeDefined();
  });
  it('retains the native reviewer for a confirmed own account', () => {
    expect(sessionPermissionModeOptions(options, undefined, undefined, { route: 'own', modeMap })).toEqual(options);
  });
});
