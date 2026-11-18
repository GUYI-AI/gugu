import { expect, it } from 'vitest';
import { catalogAllowsAutoReview } from './review-mode';
import type { ProviderPermissionModeMap } from './permissions';

const claude: ProviderPermissionModeMap = { 'ai-review': { id: 'auto', reviewRequirements: {
  minimumCliVersion: '2.1.302', modelPattern: '^claude-haiku-5-5$',
} } };
const loggedOut = { kind: 'auth-required', cliVersion: '2.1.322', reviewerAvailable: true };
it('keeps official login required while admitting the supported platform model', () => {
  expect(catalogAllowsAutoReview(claude, loggedOut, 'own', 'claude-haiku-5-5')).toBe(false);
  expect(catalogAllowsAutoReview(claude, loggedOut, 'platform', 'platform:claude-haiku-5-5')).toBe(true);
  expect(loggedOut.kind).toBe('auth-required');
});
it.each([
  { ...loggedOut, cliVersion: undefined },
  { ...loggedOut, cliVersion: '2.1.301' },
  { ...loggedOut, reviewerAvailable: false },
  { ...loggedOut, kind: 'unavailable' },
])('requires actual CLI and reviewer facts for the platform route: %j', catalog => {
  expect(catalogAllowsAutoReview(claude, catalog, 'platform', 'claude-haiku-5-5')).toBe(false);
});
it('rejects unsupported models and unknown routes without widening Codex gateway access', () => {
  expect(catalogAllowsAutoReview(claude, loggedOut, 'platform', 'gpt-6-luna')).toBe(false);
  expect(catalogAllowsAutoReview(claude, loggedOut, 'unknown', 'claude-haiku-5-5')).toBe(false);
  const codex: ProviderPermissionModeMap = { 'ai-review': { id: 'auto-review', billingRoutes: ['own'] } };
  expect(catalogAllowsAutoReview(codex, loggedOut, 'platform', 'gpt-6')).toBe(false);
});
it('binds own-account capability to the exact selected model instead of a stale target reply', () => {
  const ready = { kind: 'ready', selected: 'claude-haiku-5-5', autoReview: true, cliVersion: '2.1.322' };
  expect(catalogAllowsAutoReview(claude, ready, 'own', ready.selected)).toBe(true);
  expect(catalogAllowsAutoReview(claude, ready, 'own', 'other-model')).toBe(false);
  expect(catalogAllowsAutoReview(undefined, ready, 'own', ready.selected)).toBe(false);
  expect(catalogAllowsAutoReview(claude, { ...ready, cliVersion: undefined }, 'own', ready.selected)).toBe(false);
  expect(catalogAllowsAutoReview(claude, { ...ready, cliVersion: '2.1.301' }, 'own', ready.selected)).toBe(false);
});
