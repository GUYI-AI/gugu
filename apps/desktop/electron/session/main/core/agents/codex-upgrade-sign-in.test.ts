import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copyCodexUpgradeSignIn, type CodexAuthSlotPaths } from './codex-auth-slot';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function homes(source: string, target?: string) {
  const root = await mkdtemp(join(tmpdir(), 'codex-upgrade-sign-in-'));
  roots.push(root);
  const paths = (name: string): CodexAuthSlotPaths => ({ nativeRoot: join(root, name),
    liveStateFile: join(root, `${name}-live.json`), vaultRoot: id => join(root, name, 'vault', id), backupDir: join(root, name, 'backup') });
  const previous = paths('native'), managed = paths('managed');
  await mkdir(previous.nativeRoot);
  await writeFile(join(previous.nativeRoot, 'auth.json'), source);
  if (target) { await mkdir(managed.nativeRoot); await writeFile(join(managed.nativeRoot, 'auth.json'), target); }
  return { previous, managed };
}
const oauth = JSON.stringify({ tokens: { id_token: `header.${Buffer.from(JSON.stringify({ sub: 'fixture-user' })).toString('base64url')}.signature`, refresh_token: 'fixture-refresh' } });

it('never duplicates a ChatGPT OAuth refresh token into an empty managed home', async () => {
  const { previous, managed } = await homes(oauth);
  expect(await copyCodexUpgradeSignIn(previous, managed, 'native')).toBe(false);
  await expect(readFile(join(managed.nativeRoot, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(managed.liveStateFile)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(previous.nativeRoot, 'auth.json'), 'utf8')).toBe(oauth);
});

it('keeps an independent managed sign-in and its ownership record intact when native OAuth is present', async () => {
  const independent = '{"OPENAI_API_KEY":"fixture-managed-key"}';
  const { previous, managed } = await homes(oauth, independent);
  await writeFile(managed.liveStateFile, '{"connectionId":"native","identity":"independent"}');
  expect(await copyCodexUpgradeSignIn(previous, managed, 'native')).toBe(false);
  expect(await readFile(join(managed.nativeRoot, 'auth.json'), 'utf8')).toBe(independent);
  expect(await readFile(managed.liveStateFile, 'utf8')).toBe('{"connectionId":"native","identity":"independent"}');
  expect(await readFile(join(previous.nativeRoot, 'auth.json'), 'utf8')).toBe(oauth);
});

it('continues copying a file-backed API key byte for byte without changing its source', async () => {
  const key = '{"auth_mode":"apikey","OPENAI_API_KEY":"fixture-source-key"}\n';
  const { previous, managed } = await homes(key);
  expect(await copyCodexUpgradeSignIn(previous, managed, 'native')).toBe('api-key');
  expect(await readFile(join(managed.nativeRoot, 'auth.json'), 'utf8')).toBe(key);
  expect(await readFile(join(previous.nativeRoot, 'auth.json'), 'utf8')).toBe(key);
});
