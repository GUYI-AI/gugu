import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { RemoteFolderPicker } from '@/components/RemoteFolderPicker';
import { followRendererSession, queryClient } from '@/lib/replica';

// The picker's folders are `remoteDirectory` readings: the first path falling back to home is a derivation (no second
// navigation effect), a failed step keeps the folder stood on, and the entries of a folder opened before are there
// at once when the picker opens again.
const refuse = new Set<string>();
const listDirectory = vi.fn(async (_device: string, request: { path: string; show_hidden?: boolean }) => {
  if (refuse.has(request.path)) return { error: { code: 'permission_denied', message: 'no' } };
  if (request.path === '/gone') return { error: { code: 'not_found', message: 'gone' } };
  if (request.path === '~' || request.path === '/home/work') return { result: { path: '/home/work', home: '/home/work', entries: [{ name: 'src', kind: 'dir' }] } };
  if (request.path === '/home/work/src') return { result: { path: '/home/work/src', home: '/home/work', entries: [{ name: 'a.ts', kind: 'file' }] } };
  return { error: { code: 'permission_denied', message: 'no' } };
});
vi.mock('@/lib/deviceFs', () => ({
  deviceFsListDirectory: (...args: Parameters<typeof listDirectory>) => listDirectory(...args),
  deviceFsMakeDirectory: async () => ({ result: {} }),
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  queryClient.clear();
  followRendererSession('SIGNED_IN', 'tester');
  listDirectory.mockClear();
  refuse.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const text = () => host.textContent ?? '';

it('a first path that is not a place to stand shows the home folder, without a second navigation', async () => {
  act(() => root.render(<RemoteFolderPicker deviceId="dev" initialPath="/gone" onSelect={() => {}} />));
  await until('home is shown', () => text().includes('/home/work') && text().includes('src'));
  expect(listDirectory.mock.calls.map((call) => call[1].path)).toEqual(['/gone', '~']);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('a step that fails keeps the folder stood on and says why', async () => {
  refuse.add('/home/work/src');
  act(() => root.render(<RemoteFolderPicker deviceId="dev" initialPath="/home/work" onSelect={() => {}} />));
  await until('the folder is shown', () => text().includes('src'));
  const src = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('src'))!;
  act(() => src.click());
  await until('the refusal is said', () => text().includes('create.remoteFolders.error.permissionDeniedPath'));
  expect(text()).toContain('src');
  expect(text()).not.toContain('create.remoteFolders.empty');
});

it('a folder read before is drawn at once when the picker opens again', async () => {
  act(() => root.render(<RemoteFolderPicker deviceId="dev" initialPath="/home/work" onSelect={() => {}} />));
  await until('the folder is shown', () => text().includes('src'));
  act(() => root.unmount());
  root = createRoot(host);
  act(() => root.render(<RemoteFolderPicker deviceId="dev" initialPath="/home/work" onSelect={() => {}} />));
  expect(text()).toContain('src');
  expect(text()).not.toContain('create.remoteFolders.connecting');
});
