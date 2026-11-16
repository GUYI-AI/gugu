import { expect, it } from 'vitest';
import { autoApproveFromPermissionMode, classifyProviderPermissionMode, isGuguPermissionMode, isTopPermissionRung, resolveDeclaredPermissionMode, resolvePermissionModeFallback } from './permissions';
it('persists AI review as a separate approval authority, never full access', () => {
  expect(isGuguPermissionMode('ai-review')).toBe(true);
  expect(autoApproveFromPermissionMode('ai-review')).toBe(false);
  expect(isTopPermissionRung('ai-review')).toBe(false);
  expect(classifyProviderPermissionMode('auto', { 'ai-review': { id: 'auto' } })).toBe('ai-review');
});
it('does not silently replace a missing reviewer with a different permission mode', () => {
  expect(resolveDeclaredPermissionMode('ai-review', { edit: { id: 'acceptEdits' } })).toBeUndefined();
  expect(resolvePermissionModeFallback('ai-review', [':workspace', ':danger-full-access'])).toBeUndefined();
  expect(resolvePermissionModeFallback('edit', ['auto', 'acceptEdits'], { edit: { id: 'acceptEdits' }, 'ai-review': { id: 'auto' } })).toEqual({ mode: 'edit', modeId: 'acceptEdits' });
});
