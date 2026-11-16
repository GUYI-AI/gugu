// @vitest-environment jsdom
// A restored dock (the snapshot keeps `{dock}`, no list) and this run's read of the list fails: the reading is an error,
// so the surfaces' failure + retry branches are reached (❌ unknown for ever, the error dropped).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Reading } from '@/lib/replica';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./extensions-api', async (original) => ({
  ...(await original<typeof import('./extensions-api')>()),
  extensionsApiOf: () => ({ list: async () => ({ success: false, error: 'host gone' }) }),
}));

const { installedExtensions, useInstalledApps } = await import('./installed-extensions');
const { queryClient } = await import('@/lib/replica');

describe('useInstalledApps over a restored dock', () => {
  it('says the failed read (error), ❌ unknown', async () => {
    queryClient.clear();
    installedExtensions.set(['local'], { dock: { slots: [{ extensionId: 'alpha', name: 'Alpha' }], count: 1 } });
    // As restored: shown at once, read again when a surface shows it.
    await installedExtensions.refresh('local');
    const seen: Reading<unknown>[] = [];
    function Probe() { seen.push(useInstalledApps('local')); return null; }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<Probe />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(seen.at(-1)).toMatchObject({ state: 'error', error: expect.objectContaining({ message: 'host gone' }) });
    await act(async () => root.unmount());
  });
});
