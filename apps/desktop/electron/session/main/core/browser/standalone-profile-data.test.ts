import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerTaskBrowser, TaskPageContents } from '../../../../server/server-task-browser';
import { StandaloneBrowserPool } from './standalone-browser-pool';
import { StandaloneProfileData, toCdpCookie, toCookieParam } from './standalone-profile-data';

const work = 'persist:gugu-browser-profile-work';
const other = 'persist:gugu-browser-profile-other';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(initial: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'standalone-profile-data-'));
  roots.push(root);
  const commands: { profile: string; method: string; params?: Record<string, unknown> }[] = [];
  const opened: { profile: string; id: string; url?: string }[] = [];
  const cookies = vi.fn(async () => ({ cookies: [] as Record<string, unknown>[] }));
  const create = vi.fn(({ profile }: { profile: string }): ServerTaskBrowser => {
    const pages = new Map<string, string>();
    return {
      pageFor: vi.fn(async (id: string, url?: string) => {
        opened.push({ profile, id, url });
        pages.set(id, url ?? 'about:blank');
        return { hostCommand: async (method: string, params?: Record<string, unknown>) => {
          commands.push({ profile, method, params });
          return method === 'Network.getAllCookies' ? cookies() : method === 'Network.setCookie' ? { success: true } : {};
        } } as unknown as TaskPageContents;
      }),
      existingPage: vi.fn(async (id: string) => pages.has(id) ? { state: () => ({ url: pages.get(id)! }) } as never : null),
      closeTask: vi.fn(async (id: string) => { pages.delete(id); }),
      privateLogin: vi.fn(), dispose: vi.fn(async () => {}),
    };
  });
  const pool = new StandaloneBrowserPool({ profilesRoot: root, installation: async () => ({ version: '1', executable: '/chrome' } as never), create });
  const data = new StandaloneProfileData({ pool, profilesRoot: root, partitions: async () => [work, other] });
  const seed = async (partition: string, file = 'Cookies') => {
    const directory = pool.directoryFor(partition);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, file), 'data');
    return directory;
  };
  for (const [partition, file] of Object.entries(initial)) await seed(partition, file);
  return { root, pool, data, create, commands, opened, cookies, seed };
}
const methods = (f: Awaited<ReturnType<typeof fixture>>) => f.commands.map(command => command.method);
const signal = new AbortController().signal;

describe('standalone cookie import and data clearing', () => {
  it('maps an Electron cookie to Chrome and a Chrome cookie back, without leaking session expiry', () => {
    expect(toCdpCookie({ url: 'https://a.test/', name: 'sid', value: 'v', domain: 'a.test', path: '/', secure: true, httpOnly: true, expirationDate: 1900000000, sameSite: 'no_restriction' }))
      .toEqual({ name: 'sid', value: 'v', url: 'https://a.test/', domain: 'a.test', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: 1900000000 });
    expect(toCdpCookie({ url: 'http://a.test/', name: 'n', value: 'v', sameSite: 'unspecified' })).not.toHaveProperty('sameSite');
    expect(toCookieParam({ name: 'n', value: 'v', domain: '.a.test', path: '/', expires: -1, session: true, size: 2, httpOnly: false, secure: false }))
      .toEqual({ name: 'n', value: 'v', domain: '.a.test', path: '/', httpOnly: false, secure: false });
  });

  it('writes imported cookies through one throwaway tab and closes it so Chrome stores them', async () => {
    const f = await fixture();
    const sink = f.data.cookies(work);
    await sink.set({ url: 'https://a.test/', name: 'a', value: '1' });
    await sink.set({ url: 'https://b.test/', name: 'b', value: '2' });
    expect(f.create).toHaveBeenCalledOnce();
    expect(methods(f)).toEqual(['Network.setCookie', 'Network.setCookie']);
    expect(f.pool.inUse).toBe(true);
    await sink.flushStore();
    expect(f.pool.inUse).toBe(false);
    await f.pool.dispose();
  });

  it('counts a cookie Chrome rejected as not imported', async () => {
    const f = await fixture();
    f.create.mockImplementationOnce(() => ({
      pageFor: async () => ({ hostCommand: async () => ({ success: false }) }) as unknown as TaskPageContents,
      existingPage: async () => null, closeTask: async () => {}, privateLogin: vi.fn(), dispose: async () => {},
    }));
    const sink = f.data.cookies(work);
    await expect(sink.set({ url: 'https://a.test/', name: 'a', value: '1' })).rejects.toThrow('rejected');
    await sink.flushStore();
    expect(f.pool.inUse).toBe(false);
  });

  it('clears cookies or cache through Chrome only for profiles that exist', async () => {
    const f = await fixture({ [work]: 'Cookies' });
    await f.data.clear(other, 'cookies');
    expect(f.create).not.toHaveBeenCalled();
    await f.data.clear(work, 'cookies');
    await f.data.clear(work, 'cache');
    expect(methods(f)).toEqual(['Network.clearBrowserCookies', 'Network.clearBrowserCache']);
    expect(f.pool.inUse).toBe(false);
  });

  it('removes a dormant profile without starting Chrome', async () => {
    const f = await fixture({ [work]: 'Cookies', [other]: 'Cookies' });
    await f.data.clear(work, 'all');
    expect(f.create).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([path.basename(f.pool.directoryFor(other))]);
  });

  it('empties a running profile and reopens its tabs where they were; other profiles are untouched', async () => {
    const f = await fixture({ [other]: 'Cookies' });
    await f.pool.pageFor({ browserId: 'tab', partition: work, url: 'https://a.test/page', signal });
    const directory = await f.seed(work, 'Local Storage');
    await f.data.clear(work, 'all');
    await expect(readdir(directory)).rejects.toThrow();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.opened.filter(page => page.id === 'tab').map(page => page.url)).toEqual(['https://a.test/page', 'https://a.test/page']);
    expect(f.pool.livePartitions).toEqual([work]);
    expect(await readdir(f.pool.directoryFor(other))).toEqual(['Cookies']);
    await f.pool.dispose();
  });

  it('site data keeps the cookies: they are read first and put back before the tabs reopen', async () => {
    const f = await fixture({ [work]: 'Cookies' });
    f.cookies.mockResolvedValueOnce({ cookies: [{ name: 'sid', value: 'v', domain: 'a.test', path: '/', expires: 1900000000, session: false, size: 4 }] });
    await f.pool.pageFor({ browserId: 'tab', partition: work, url: 'https://a.test/', signal });
    await f.data.clear(work, 'siteData');
    const order = f.commands.map(command => command.method);
    expect(order).toEqual(['Network.getAllCookies', 'Storage.setCookies']);
    expect(f.commands[1]!.params).toEqual({ cookies: [{ name: 'sid', value: 'v', domain: 'a.test', path: '/', expires: 1900000000 }] });
    expect(f.opened.at(-1)).toMatchObject({ id: 'tab', url: 'https://a.test/' });
    await f.pool.dispose();
  });

  it('clears every profile for one category, and for "all" also directories no profile owns', async () => {
    const f = await fixture({ [work]: 'Cookies', [other]: 'Cookies' });
    const orphan = path.join(f.root, 'deleted-profile');
    await mkdir(orphan);
    await f.data.clearAll('cache');
    expect(methods(f)).toEqual(['Network.clearBrowserCache', 'Network.clearBrowserCache']);
    expect(await readdir(f.root)).toContain('deleted-profile');
    await f.data.clearAll('all');
    expect(await readdir(f.root)).toEqual([]);
  });
});
