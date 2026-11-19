import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { ServerTaskBrowser, TaskPageContents } from '../../../../server/server-task-browser';
import type { StandaloneKernelInstallation } from './standalone-kernel-installer';
import { StandaloneBrowserPool } from './standalone-browser-pool';

const installed = (version: string) => ({ version, executable: `/engines/${version}/chrome` }) as StandaloneKernelInstallation;
const profile = 'persist:gugu-browser-profile-shared';
const signal = new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const drivers: ServerTaskBrowser[] = [];
  const current = { value: installed('158.0.1.1') };
  const create = vi.fn((_input: { profile: string; executable: string }): ServerTaskBrowser => {
    const pages = new Map<string, TaskPageContents>();
    const driver: ServerTaskBrowser = {
      pageFor: vi.fn(async id => {
        const page = pages.get(id) ?? { id } as unknown as TaskPageContents;
        pages.set(id, page);
        return page;
      }),
      existingPage: vi.fn(async () => null),
      closeTask: vi.fn(async id => { pages.delete(id); }),
      privateLogin: vi.fn(), dispose: vi.fn(async () => {}),
    };
    drivers.push(driver);
    return driver;
  });
  const installation = vi.fn(async () => current.value);
  const pool = new StandaloneBrowserPool({ profilesRoot: '/isolated/profiles', installation, create });
  const open = (browserId: string, partition = profile) => pool.pageFor({ browserId, partition, signal, url: 'https://example.test' });
  return { pool, open, create, drivers, current, installation };
}

describe('standalone browser profile lifetime', () => {
  it('keeps the installation in use for a registered hidden tab without launching Chrome', async () => {
    const f = fixture();
    f.pool.reserveTab('hidden', profile);
    expect(f.pool.inUse).toBe(true);
    expect(f.create).not.toHaveBeenCalled();
    await f.pool.closeTab('hidden');
    expect(f.pool.inUse).toBe(false);
    await f.pool.dispose();
  });
  it('shares a process only for the same profile while keeping each tab distinct', async () => {
    const f = fixture();
    const [one, two] = await Promise.all([f.open('one'), f.open('two')]);
    expect(one).not.toBe(two);
    expect(f.create).toHaveBeenCalledTimes(1);
    const originalProfile = f.create.mock.calls[0]![0].profile;
    expect(path.dirname(originalProfile)).toBe('/isolated/profiles');
    await f.open('isolated', 'persist:gugu-browser-profile-other');
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[1]![0].profile).not.toBe(originalProfile);
    await f.pool.closeTab('one');
    expect(f.drivers[0]!.dispose).not.toHaveBeenCalled();
    expect(f.drivers[0]!.closeTask).toHaveBeenCalledWith('one');
    await f.pool.dispose();
  });

  it('defers an installed update until the shared profile is idle, then retains its directory', async () => {
    const f = fixture();
    await f.open('old');
    f.current.value = installed('159.0.1.1');
    await f.open('next');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect([...f.pool.versionsInUse]).toEqual(['158.0.1.1']);
    await f.pool.closeTab('old');
    await f.pool.closeTab('next');
    expect(f.pool.inUse).toBe(false);
    await f.open('updated');
    expect(f.create.mock.calls[1]![0]).toEqual({
      profile: f.create.mock.calls[0]![0].profile, executable: '/engines/159.0.1.1/chrome',
    });
    await f.pool.dispose();
  });

  it('waits for the former process to exit before reopening the same persistent directory', async () => {
    const f = fixture();
    await f.open('first');
    const exited = deferred<void>();
    vi.mocked(f.drivers[0]!.dispose).mockImplementation(() => exited.promise);
    const closing = f.pool.closeTab('first');
    await vi.waitFor(() => expect(f.drivers[0]!.dispose).toHaveBeenCalledOnce());
    const reopened = f.open('second');
    await Promise.resolve();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.pool.inUse).toBe(true);
    exited.resolve();
    await closing;
    await reopened;
    expect(f.create).toHaveBeenCalledTimes(2);
    await f.pool.dispose();
  });

  it('closing a tab while installation is being read still closes its eventual page', async () => {
    const f = fixture();
    const ready = deferred<StandaloneKernelInstallation>();
    f.installation.mockImplementation(() => ready.promise);
    const opened = f.open('opening');
    await vi.waitFor(() => expect(f.installation).toHaveBeenCalledOnce());
    const closed = f.pool.closeTab('opening');
    ready.resolve(installed('158.0.1.1'));
    await opened;
    await closed;
    expect(f.drivers[0]!.closeTask).toHaveBeenCalledWith('opening');
    expect(f.drivers[0]!.dispose).toHaveBeenCalledOnce();
    expect(f.pool.inUse).toBe(false);
    await f.pool.dispose();
  });

  it('rejects concurrent attempts to move an opening tab into another profile', async () => {
    const f = fixture();
    const ready = deferred<StandaloneKernelInstallation>();
    f.installation.mockImplementation(() => ready.promise);
    const opened = f.open('owned');
    await expect(f.open('owned', 'persist:gugu-browser-profile-foreign')).rejects.toThrow('another profile');
    ready.resolve(installed('158.0.1.1'));
    await opened;
    expect(f.create).toHaveBeenCalledTimes(1);
    await f.pool.dispose();
  });

  it('does not launch anything for an aborted request or invalid partition', async () => {
    const f = fixture();
    await expect(f.pool.pageFor({ browserId: 'cancelled', partition: profile, signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(f.open('foreign', 'persist:owner-chrome')).rejects.toThrow('Invalid standalone');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.pool.inUse).toBe(false);
    await f.pool.dispose();
  });

  it('keeps a profile in use when closing its process fails, blocking binary removal', async () => {
    const f = fixture();
    await f.open('last');
    vi.mocked(f.drivers[0]!.dispose).mockRejectedValueOnce(new Error('process has not exited'));
    await expect(f.pool.closeTab('last')).rejects.toThrow('process has not exited');
    expect(f.pool.inUse).toBe(true);
    expect([...f.pool.versionsInUse]).toEqual(['158.0.1.1']);
    await f.pool.dispose();
    expect(f.pool.inUse).toBe(false);
  });
});
