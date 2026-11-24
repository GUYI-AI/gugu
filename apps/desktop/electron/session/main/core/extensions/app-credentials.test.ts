import { describe, expect, it, vi } from 'vitest';
import { parseExtensionManifest } from '@shared/extensions/manifest';
import { createAppCredentials, type AppCredentialDeps, type SavedCredential } from './app-credentials';

const mona: SavedCredential = { id: 'c-mona', name: 'GitHub', origin: 'https://github.com', account: 'mona', maskedAccount: 'm***' };
const work: SavedCredential = { id: 'c-work', name: 'GitHub', origin: 'https://github.com', account: 'work', maskedAccount: 'w***' };

function setup(over: Partial<AppCredentialDeps> = {}) {
  const picks = new Map<string, string>();
  const sent: { url: string; init: { method: string; headers: Record<string, string>; body?: string; redirect: string } }[] = [];
  const deps: AppCredentialDeps = {
    declarations: () => [{ site: 'github.com', header: 'Authorization', format: 'Bearer {value}' }],
    grantedHosts: () => ['api.github.com'],
    picked: (_app, site) => picks.get(site) ?? null,
    pick: (_app, site, id) => { if (id) picks.set(site, id); else picks.delete(site); },
    saved: async () => [mona, work],
    secret: async (id) => `token-${id}`,
    connectorDefault: async () => 'c-work',
    save: vi.fn(async () => 'c-new'),
    ask: vi.fn(async () => undefined),
    fetch: vi.fn(async (url, init) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9', 'set-cookie': 'x=1' } });
    }),
    ...over,
  };
  return { credentials: createAppCredentials(deps), sent, deps };
}

describe('App credentials (API 61)', () => {
  it('choose (API 64): asks in the window that draws the page with the App\'s words, then says whether one is chosen', async () => {
    const { credentials, deps } = setup({ saved: async () => [], connectorDefault: async () => null });
    const words = { hint: 'A fine-grained token', help: 'https://github.com/settings/personal-access-tokens/new' };
    await expect(credentials.choose('pr', 'GitHub PR', { site: 'github.com', ...words }, { embedderId: 7 })).resolves.toEqual({ chosen: false });
    expect(deps.ask).toHaveBeenCalledWith({ embedderId: 7 }, { extensionId: 'pr', appName: 'GitHub PR', site: 'github.com', hint: 'A fine-grained token', help: 'https://github.com/settings/personal-access-tokens/new' });
    await expect(credentials.choose('pr', 'GitHub PR', { site: 'gitlab.com' }, { embedderId: 7 })).rejects.toThrow(/declares no credential/);
    await expect(credentials.choose('pr', 'GitHub PR', { site: 'github.com', help: 'http://example.com' }, { embedderId: 7 })).rejects.toThrow(/https/);
  });

  it('the dialog\'s save keeps the value in the vault for the declared website and picks it for the App', async () => {
    const { credentials, deps } = setup();
    await credentials.saveAndPick('pr', 'github.com', { name: ' GitHub PR · github.com ', value: ' ghp_x ' });
    expect(deps.save).toHaveBeenCalledWith({ origin: 'https://github.com', name: 'GitHub PR · github.com', account: '', password: 'ghp_x' });
    expect(deps.picked('pr', 'github.com')).toBe('c-new');
    await expect(credentials.saveAndPick('pr', 'github.com', { name: 'x', value: 'a\nb' })).rejects.toThrow(/one line/);
  });

  it('uses the connector default until the person picks, then their pick', async () => {
    const { credentials, sent } = setup();
    await expect(credentials.states('pr')).resolves.toEqual([
      expect.objectContaining({ site: 'github.com', picked: false, chosen: expect.objectContaining({ id: 'c-work', label: 'GitHub · work' }) }),
    ]);
    credentials.pick('pr', 'github.com', 'c-mona');
    const answer = await credentials.request('pr', { site: 'github.com', url: 'https://api.github.com/repos/a/b/pulls/1' }, false);
    expect(answer).toEqual({ status: 200, data: { ok: true }, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9' } });
    expect(sent[0]).toMatchObject({ url: 'https://api.github.com/repos/a/b/pulls/1', init: { method: 'GET', redirect: 'manual', headers: { Authorization: 'Bearer token-c-mona' } } });
  });

  it('falls back from a deleted pick and says when nothing is chosen', async () => {
    const { credentials } = setup({ connectorDefault: async () => null });
    credentials.pick('pr', 'github.com', 'c-gone');
    await expect(credentials.request('pr', { site: 'github.com', url: 'https://api.github.com/user' }, false))
      .rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('No saved credential is chosen') });
    const single = setup({ connectorDefault: async () => null, saved: async () => [mona] });
    await expect(single.credentials.request('pr', { site: 'github.com', url: 'https://api.github.com/user' }, false)).resolves.toMatchObject({ status: 200 });
  });

  it('sends only over https to a granted host of the site, with plain extra headers', async () => {
    const { credentials, deps } = setup();
    for (const url of ['http://api.github.com/x', 'https://evil.example/x', 'https://uploads.github.com/x', 'https://api.github.com:8443/x', 'not a url']) {
      await expect(credentials.request('pr', { site: 'github.com', url }, false)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(credentials.request('pr', { site: 'github.com', url: 'https://api.github.com/x', headers: { Cookie: 'a' } }, false)).rejects.toMatchObject({ code: 'invalid' });
    await expect(credentials.request('pr', { site: 'gitlab.com', url: 'https://api.github.com/x' }, false)).rejects.toMatchObject({ code: 'invalid' });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('writes with a method and a JSON body; other methods are refused', async () => {
    const { credentials, sent } = setup();
    await credentials.request('pr', { site: 'github.com', method: 'put', url: 'https://api.github.com/repos/a/b/pulls/1/merge', body: { sha: 'abc' } }, true);
    expect(sent[0]!.init).toMatchObject({ method: 'PUT', body: '{"sha":"abc"}', headers: { 'Content-Type': 'application/json' } });
    await expect(credentials.request('pr', { site: 'github.com', method: 'GET', url: 'https://api.github.com/x' }, true)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('answers unavailable when the vault cannot be read, or a value could break the header', async () => {
    const locked = setup({ saved: async () => { throw Object.assign(new Error('x'), { code: 'SYSTEM_STORAGE_UNAVAILABLE' }); } });
    await expect(locked.credentials.request('pr', { site: 'github.com', url: 'https://api.github.com/x' }, false))
      .rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('Settings › Passwords') });
    const broken = setup({ secret: async () => 'a\r\nX-Evil: 1' });
    await expect(broken.credentials.request('pr', { site: 'github.com', url: 'https://api.github.com/x' }, false)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('permissions.credentials in a manifest', () => {
  const manifest = (apiVersion: number, network: string[]) => ({
    id: 'pr', name: 'PR', version: '1.0.0', apiVersion, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: 'PR' }] },
    permissions: { network, credentials: [{ site: 'github.com', header: 'Authorization', format: 'Bearer {value}' }] },
  });
  it('needs API 61 and a network host of the site', () => {
    expect(() => parseExtensionManifest(manifest(61, ['api.github.com']))).not.toThrow();
    expect(() => parseExtensionManifest(manifest(60, ['api.github.com']))).toThrow(/apiVersion 61/);
    expect(() => parseExtensionManifest(manifest(61, ['api.example.com']))).toThrow(/network names no host of github.com/);
  });
});

describe('the picked credential, kept per App on this device', () => {
  it('is forgotten when the App is uninstalled', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { ExtensionsService } = await import('./extensions-service');
    const work = mkdtempSync(path.join(tmpdir(), 'gugu-app-credentials-'));
    const source = path.join(work, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, 'index.html'), '<p>pr</p>');
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
      id: 'pr', name: 'PR', version: '1.0.0', apiVersion: 61, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
      permissions: { network: ['api.github.com'], credentials: [{ site: 'github.com', header: 'Authorization', format: 'Bearer {value}' }] },
      contributes: { tabs: [{ name: 'main', title: 'PR' }] },
    }));
    const service = new ExtensionsService(path.join(work, 'installed'));
    const install = () => service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder');
    install();
    service.setCredentialChoice('pr', 'github.com', 'c-mona');
    expect(service.credentialChoice('pr', 'github.com')).toBe('c-mona');
    service.uninstall('pr');
    install();
    expect(service.credentialChoice('pr', 'github.com')).toBeNull();
  });
});
