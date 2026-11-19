import { expect, it } from 'vitest';
import { composerModelOptions, sanitizeHarnessModelOptions } from './platform-model-options';
it('removes the reviewer from a native catalog while preserving normal model rows', () => {
  expect(sanitizeHarnessModelOptions({ 'codex-auto-review': { name: 'Reviewer' }, 'gpt-6.1-sol': { name: 'GPT-6.1 Sol' } })).toEqual({ 'gpt-6.1-sol': { name: 'GPT-6.1 Sol' } });
  expect(sanitizeHarnessModelOptions({ 'codex-auto-review': { name: 'Reviewer' } })).toBeNull();
});
it('does not restore a stored internal reviewer through the current-model visibility exception', () => {
  const rows = [{ id: 'codex-auto-review', displayName: 'Reviewer', creditMultiplier: 1, contextWindow: null }];
  expect(composerModelOptions(null, rows, undefined, 'codex-auto-review')).toBeNull();
});
