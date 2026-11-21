import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStandaloneKernel, readStandaloneKernelInstallation, type StandaloneKernelAsset } from './standalone-kernel-installer';

const version = '158.0.8127.36';
const payload = 'reviewed archive fixture';
const executable = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const asset: StandaloneKernelAsset = {
  version, platform: 'darwin-arm64', bytes: Buffer.byteLength(payload),
  sha256: createHash('sha256').update(payload).digest('hex'),
  url: `https://cdn.npmmirror.com/binaries/chrome-for-testing/${version}/mac-arm64/chrome-mac-arm64.zip`,
};
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'gugu-kernel-install-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fixture(body = payload) {
  return {
    fetch: vi.fn(async () => new Response(body, { headers: { 'content-length': String(asset.bytes) } })),
    unpack: vi.fn(async (_archive: string, directory: string) => {
      const binary = path.join(directory, executable);
      await mkdir(path.dirname(binary), { recursive: true });
      await writeFile(binary, 'browser fixture', { mode: 0o755 });
    }),
    version: vi.fn(async () => `Google Chrome for Testing ${version}`),
    diskBytes: vi.fn(async () => 4096),
  };
}

function options(signal = new AbortController().signal) {
  return { root, asset, signal, progress: vi.fn() };
}

describe('standalone browser verified installation', () => {
  it('publishes a complete inspected version and reuses it without another download', async () => {
    const dependencies = fixture();
    const input = options();
    const installed = await installStandaloneKernel(input, dependencies);
    expect(installed).toMatchObject({ version, sha256: asset.sha256, downloadBytes: asset.bytes, installedBytes: 4096 });
    expect(await readFile(installed.executable, 'utf8')).toBe('browser fixture');
    expect(await readdir(root)).toEqual([version]);
    expect(await readStandaloneKernelInstallation(root, asset)).toEqual(installed);
    expect(input.progress).toHaveBeenLastCalledWith({ stage: 'installing', receivedBytes: asset.bytes, totalBytes: asset.bytes });
    await expect(installStandaloneKernel(options(), dependencies)).resolves.toEqual(installed);
    expect(dependencies.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['corrupt archive fixture!', 'short'])('refuses wrong bytes before unpacking, preserving an older version (%s)', async (body) => {
    await mkdir(path.join(root, '157.0.0.1'));
    await writeFile(path.join(root, '157.0.0.1/installation.json'), 'older installation');
    const dependencies = fixture(body);
    await expect(installStandaloneKernel(options(), dependencies)).rejects.toThrow(/checksum|exceeds/);
    expect(dependencies.unpack).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(['157.0.0.1']);
    expect(await readFile(path.join(root, '157.0.0.1/installation.json'), 'utf8')).toBe('older installation');
  });

  it('cancels a download before unpacking or publishing and removes only its temporary work', async () => {
    const dependencies = fixture();
    const cancellation = new AbortController();
    const input = options(cancellation.signal);
    input.progress.mockImplementation((progress) => {
      if (progress.receivedBytes > 0) cancellation.abort(new Error('cancelled by person'));
    });
    await expect(installStandaloneKernel(input, dependencies)).rejects.toThrow('cancelled by person');
    expect(dependencies.unpack).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects an executable from another browser version without registering it', async () => {
    const dependencies = fixture();
    dependencies.version.mockResolvedValue('Google Chrome for Testing 157.0.0.1');
    await expect(installStandaloneKernel(options(), dependencies)).rejects.toThrow('version does not match');
    expect(await readdir(root)).toEqual([]);
  });

  it('does not treat a missing executable as an installed browser', async () => {
    const installed = await installStandaloneKernel(options(), fixture());
    await rm(installed.executable);
    await expect(readStandaloneKernelInstallation(root, asset)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('refuses an installed browser whose executable permission was removed', async () => {
    const installed = await installStandaloneKernel(options(), fixture());
    await chmod(installed.executable, 0o644);
    await expect(readStandaloneKernelInstallation(root, asset)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('does not publish an archive with a non-executable browser', async () => {
    const dependencies = fixture();
    const unpack = dependencies.unpack;
    dependencies.unpack = vi.fn(async (archive, directory) => {
      await unpack(archive, directory);
      await chmod(path.join(directory, executable), 0o644);
    });
    await expect(installStandaloneKernel(options(), dependencies)).rejects.toThrow();
    expect(dependencies.version).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a foreign source and a version containing a path before any network request', async () => {
    const dependencies = fixture();
    for (const invalid of [{ ...asset, url: 'https://example.test/chrome.zip' }, { ...asset, version: '../other' }]) {
      await expect(installStandaloneKernel({ ...options(), asset: invalid }, dependencies)).rejects.toThrow();
    }
    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
