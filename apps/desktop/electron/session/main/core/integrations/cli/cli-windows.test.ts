import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cliToolRecipe } from './cli-tools';
import { ensureCliTool, installedCliTool } from './cli-tool-installer';
import { publishCliLauncher, removeCliLauncher } from './cli-integrations';
import { removeCliCredentials } from './cli-credentials';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gugu-windows-cli-'));
  vi.stubEnv('GUGU_HOME', path.join(root, 'account with spaces %'));
  vi.stubEnv('GUGU_CLOUD_COMPUTER', '0');
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const windows = () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
};
async function archive(name: string, files: Record<string, string | Buffer>): Promise<Buffer> {
  const source = path.join(root, name);
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), bytes);
  }
  const file = path.join(root, `${name}.tgz`);
  execFileSync('tar', ['-czf', file, '-C', source, ...new Set(Object.keys(files).map(file => file.split('/')[0]!))]);
  return readFile(file);
}

it.each(['dws', 'wecom-cli'] as const)('installs the verified Windows %s executable and Skills without vendor install scripts', async tool => {
  const program = Buffer.from('MZ-Windows-test-program');
  const recipe = cliToolRecipe(tool, 'win32');
  let pkg: Buffer;
  if (tool === 'dws') {
    const zip = new JSZip(); zip.file('dws.exe', program);
    const binary = await zip.generateAsync({ type: 'nodebuffer' });
    const skills = new JSZip(); skills.file('mono/SKILL.md', 'DWS instructions');
    pkg = await archive('npm', {
      'package/assets/dws-windows-amd64.zip': binary,
      'package/assets/checksums.txt': `${createHash('sha256').update(binary).digest('hex')}  dws-windows-amd64.zip\n`,
      'package/assets/dws-skills.zip': await skills.generateAsync({ type: 'nodebuffer' }),
    });
  } else pkg = await archive('npm', { 'package/bin/wecom-cli.exe': program });
  const skills = await archive('skills', { 'source/skills/wecomcli-basic/SKILL.md': 'WeCom instructions' });
  const original = recipe.binaryPackage('win32-x64');
  vi.spyOn(recipe, 'binaryPackage').mockReturnValue({ ...original, integrity: `sha512-${createHash('sha512').update(pkg).digest('base64')}` });
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('codeload.github.com')) return new Response(new Uint8Array(skills));
    if (url === 'https://example.test/package.tgz') return new Response(new Uint8Array(pkg));
    return Response.json({ dist: { tarball: 'https://example.test/package.tgz' } });
  });
  vi.stubGlobal('fetch', fetch); windows();
  const installed = await ensureCliTool(tool);
  expect(installed.binPath.endsWith(`${recipe.bin}.exe`)).toBe(true);
  expect(await readFile(installed.binPath)).toEqual(program);
  expect(await readFile(path.join(installed.skillsDir, tool === 'dws' ? 'dws/SKILL.md' : 'wecomcli-basic/SKILL.md'), 'utf8')).toContain('instructions');
  await publishCliLauncher(recipe, installed);
  const dir = path.join(process.env.GUGU_HOME!, 'integration-tools/bin');
  const cmd = await readFile(path.join(dir, `${recipe.bin}.cmd`), 'utf8');
  const ps = await readFile(path.join(dir, `${recipe.bin}.ps1`), 'utf8');
  expect(cmd).toContain('setlocal DisableDelayedExpansion'); expect(cmd).toContain('spaces %%');
  expect(cmd).toContain('.exe" %*'); expect(ps).toContain('.exe\' @args');
  if (tool === 'dws') {
    expect(cmd).toContain('DWS_KEYCHAIN_DIR='); expect(ps).toContain('$env:DWS_CONFIG_DIR=');
    expect(recipe.env(installed.homeDir).USERPROFILE).toBe(installed.homeDir);
  }
  await removeCliLauncher(recipe);
  await expect(readFile(path.join(dir, `${recipe.bin}.cmd`))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(dir, `${recipe.bin}.ps1`))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects unsupported Windows tools before download, including an existing cached install', async () => {
  windows(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const tool of ['lark-cli', 'tmeet'] as const) {
    const marker = path.join(path.dirname(installedCliTool(tool).binPath), '..', '.complete');
    await mkdir(path.dirname(marker), { recursive: true }); await writeFile(marker, 'old cached installation');
    await expect(ensureCliTool(tool)).rejects.toThrow('尚未在这台设备上实现');
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('clears Windows DWS through the isolated vendor reset before deleting its home, and preserves the home on failure', async () => {
  windows(); const installed = installedCliTool('dws');
  await mkdir(path.dirname(installed.binPath), { recursive: true });
  await writeFile(path.join(path.dirname(installed.binPath), '..', '.complete'), installed.version);
  const log = path.join(root, 'reset.json');
  await writeFile(installed.binPath, `#!/bin/sh\nprintf '%s\\n' "$*" "$DWS_KEYCHAIN_DIR" "$DWS_CONFIG_DIR" > '${log}'\nexit 1\n`);
  await chmod(installed.binPath, 0o755);
  await mkdir(installed.homeDir, { recursive: true }); await writeFile(path.join(installed.homeDir, 'sentinel'), 'keep on error');
  await expect(removeCliCredentials('dws')).rejects.toThrow('登录信息未能清除');
  expect(await readFile(path.join(installed.homeDir, 'sentinel'), 'utf8')).toBe('keep on error');
  expect(await readFile(log, 'utf8')).toContain(`auth reset\n${path.join(installed.homeDir, 'keychain')}\n${path.join(installed.homeDir, '.dws')}`);
  await writeFile(installed.binPath, '#!/bin/sh\nexit 0\n');
  await removeCliCredentials('dws');
  await expect(readFile(path.join(installed.homeDir, 'sentinel'))).rejects.toMatchObject({ code: 'ENOENT' });
});
