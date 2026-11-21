import { afterEach, expect, it, vi } from 'vitest';
import { importSourceCounts } from '@/components/settings/data-import/import-replicas';
import { registerExtraImportProviders, type ImportProvider } from '@/components/settings/data-import/import-providers';
import { followRendererSession, queryClient } from '@/lib/replica';
const log = vi.hoisted(() => vi.fn());
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: log, error: log }) }));
afterEach(async () => { await queryClient.cancelQueries(); queryClient.clear(); followRendererSession('SIGNED_OUT', null); vi.clearAllMocks(); });
it('logs a source read failure and keeps it an error rather than caching a false zero', async () => {
  const error = new Error('Unsupported task index');
  const provider: ImportProvider = { id: 'scan-failure-fixture', label: 'Fixture', iconId: 'codex',
    scan: async () => { throw error; }, importAll: async () => ({ imported: [], existing: 0, failed: 0 }) };
  const unregister = registerExtraImportProviders([provider]);
  followRendererSession('SIGNED_IN', 'source-count-fixture');
  try {
    await expect(importSourceCounts.fetch(provider.id, null)).rejects.toBe(error);
    expect(importSourceCounts.peek(provider.id, null)).toMatchObject({ state: 'error', error });
    expect(log).toHaveBeenCalledWith({ sourceId: provider.id, deviceId: null, error }, 'Import source scan failed');
  } finally { unregister(); }
});
