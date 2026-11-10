import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { reloadRouteChange } = await import('./reload-native-session');
const { recordModelSource } = await import('@main/core/usage/model-source-recorder');

/**
 * 2026-11-10 gpu: a codex assistant created on codex's own model (no per-session choice) was switched to 「GLM 5.3 Flash」
 * in its settings. The reload read "no record = route unchanged" and resumed the openai thread; codex 0.167 refused it
 * (modelProviderMismatch) on every start and the assistant never answered again.
 */
describe('reloadRouteChange', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  const change = (input: Partial<Parameters<typeof reloadRouteChange>[0]>) => reloadRouteChange({
    sessionId: 'conv-1', providerId: 'codex', surface: 'acp', platformBefore: undefined, target: 'platform', ...input,
  });

  it('moves a record-less codex assistant that started on its own model to a new native session', () => {
    recordModelSource('conv-1', 'byok', 1);
    expect(change({})).toBe('replace');
  });

  it('answers a codex session TUI by the app-server it rides on', () => {
    recordModelSource('conv-1', 'byok', 1);
    expect(change({ surface: 'tui' })).toBe('replace');
  });

  it('reads the route from the last start, not from a stale per-session choice', () => {
    recordModelSource('conv-1', 'byok', 1);
    recordModelSource('conv-1', 'gugu', 2);
    expect(change({ platformBefore: null })).toBe('none');
    expect(change({ platformBefore: null, target: 'own' })).toBe('replace');
  });

  it('keeps the native session when the engine resumes across routes', () => {
    recordModelSource('conv-1', 'gugu', 1);
    expect(change({ providerId: 'claude', target: 'own' })).toBe('preserve');
  });

  it('falls back to the per-session choice for a session started before the ledger, and cannot tell without either', () => {
    expect(change({ platformBefore: null })).toBe('replace');
    expect(change({ platformBefore: { modelId: 'glm-5.3-flash' } })).toBe('none');
    expect(change({})).toBe('none');
    expect(change({ target: null, platformBefore: null })).toBe('none');
  });
});
