import { createHash, randomUUID } from 'node:crypto';
import { execFile } from '@gugu/core/local/childProcess';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const INSTALL_SCHEMA = 'gugu-standalone-browser/1';
const EXECUTABLE = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

export interface StandaloneKernelAsset {
  version: string;
  platform: 'darwin-arm64';
  url: string;
  bytes: number;
  sha256: string;
}

export interface StandaloneKernelInstallation {
  schema: typeof INSTALL_SCHEMA;
  version: string;
  platform: 'darwin-arm64';
  sha256: string;
  downloadBytes: number;
  installedBytes: number;
  executable: string;
}

export type StandaloneKernelProgress = {
  stage: 'downloading' | 'installing';
  receivedBytes: number;
  totalBytes: number;
};

/** Only a reviewed full Chrome archive may enter the installer; it never discovers a moving version. */
export function validateStandaloneKernelAsset(asset: StandaloneKernelAsset): void {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(asset.version) || asset.platform !== 'darwin-arm64' ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
    throw new Error('Invalid standalone browser archive pin');
  }
  const expected = `https://cdn.npmmirror.com/binaries/chrome-for-testing/${asset.version}/mac-arm64/chrome-mac-arm64.zip`;
  if (asset.url !== expected) throw new Error('Unreviewed standalone browser download source');
}

export async function readStandaloneKernelInstallation(root: string, asset: StandaloneKernelAsset): Promise<StandaloneKernelInstallation | null> {
  validateStandaloneKernelAsset(asset);
  const directory = path.join(root, asset.version);
  let text: string;
  try { text = await readFile(path.join(directory, 'installation.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const value = JSON.parse(text) as StandaloneKernelInstallation;
  const executable = path.join(directory, EXECUTABLE);
  if (value.schema !== INSTALL_SCHEMA || value.version !== asset.version || value.platform !== asset.platform ||
      value.sha256 !== asset.sha256 || value.downloadBytes !== asset.bytes || value.executable !== executable ||
      !Number.isSafeInteger(value.installedBytes) || value.installedBytes <= 0 || !(await stat(executable)).isFile()) {
    throw new Error('Standalone browser installation does not match its reviewed archive');
  }
  await access(executable, constants.X_OK);
  return value;
}

type InstallerDependencies = {
  fetch: typeof globalThis.fetch;
  unpack(archive: string, directory: string): Promise<void>;
  version(executable: string, profile: string): Promise<string>;
  diskBytes(directory: string): Promise<number>;
};

const production: InstallerDependencies = {
  fetch: (...args) => globalThis.fetch(...args),
  unpack: async (archive, directory) => { await execute('/usr/bin/ditto', ['-xk', archive, directory]); },
  version: async (executable, profile) => (await execute(executable, [`--user-data-dir=${profile}`, '--version'], { timeout: 15_000 })).stdout.trim(),
  diskBytes: async (directory) => {
    const output = (await execute('/usr/bin/du', ['-sk', directory])).stdout;
    const bytes = Number(output.match(/^\d+/)?.[0]) * 1024;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Could not measure standalone browser storage');
    return bytes;
  },
};

/** Stage, hash and inspect before publishing a version. Cancellation never replaces an installed browser. */
export async function installStandaloneKernel(options: {
  root: string;
  asset: StandaloneKernelAsset;
  signal: AbortSignal;
  progress: (value: StandaloneKernelProgress) => void;
}, dependencies: InstallerDependencies = production): Promise<StandaloneKernelInstallation> {
  const { root, asset, signal, progress } = options;
  if (!path.isAbsolute(root)) throw new Error('Standalone browser installation requires an absolute storage directory');
  validateStandaloneKernelAsset(asset);
  signal.throwIfAborted();
  const existing = await readStandaloneKernelInstallation(root, asset);
  if (existing) return existing;
  await mkdir(root, { recursive: true });
  const temporary = path.join(root, `.install-${randomUUID()}`);
  const unpacked = path.join(temporary, 'unpacked');
  const archive = path.join(temporary, 'chrome.zip');
  await mkdir(unpacked, { recursive: true });
  try {
    const response = await dependencies.fetch(asset.url, { signal, redirect: 'error' });
    if (response.status !== 200 || !response.body) throw new Error(`Standalone browser download returned HTTP ${response.status}`);
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== asset.bytes) throw new Error('Standalone browser download size changed');
    const file = await open(archive, 'wx');
    const hash = createHash('sha256');
    let received = 0;
    try {
      const reader = response.body.getReader();
      try {
        progress({ stage: 'downloading', receivedBytes: 0, totalBytes: asset.bytes });
        for (let next = await reader.read(); !next.done; next = await reader.read()) {
          const chunk = next.value;
          signal.throwIfAborted();
          received += chunk.byteLength;
          if (received > asset.bytes) throw new Error('Standalone browser download exceeds its reviewed size');
          hash.update(chunk);
          await file.writeFile(chunk);
          progress({ stage: 'downloading', receivedBytes: received, totalBytes: asset.bytes });
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } finally { await file.close(); }
    signal.throwIfAborted();
    if (received !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('Standalone browser download checksum mismatch');
    progress({ stage: 'installing', receivedBytes: received, totalBytes: asset.bytes });
    await dependencies.unpack(archive, unpacked);
    signal.throwIfAborted();
    const binary = path.join(unpacked, EXECUTABLE);
    if (!(await stat(binary)).isFile()) throw new Error('Standalone browser archive has no expected executable');
    await access(binary, constants.X_OK);
    const actualVersion = await dependencies.version(binary, path.join(temporary, 'version-profile'));
    if (!actualVersion.endsWith(` ${asset.version}`)) throw new Error('Standalone browser executable version does not match its archive');
    const installedBytes = await dependencies.diskBytes(unpacked);
    signal.throwIfAborted();
    const target = path.join(root, asset.version);
    const installation: StandaloneKernelInstallation = {
      schema: INSTALL_SCHEMA, version: asset.version, platform: asset.platform,
      sha256: asset.sha256, downloadBytes: asset.bytes, installedBytes,
      executable: path.join(target, EXECUTABLE),
    };
    await writeFile(path.join(unpacked, 'installation.json'), JSON.stringify(installation) + '\n', { flag: 'wx' });
    await rename(unpacked, target);
    return installation;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
