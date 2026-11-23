import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { activateCodexAccount, type CodexAuthSlotPaths } from './codex-auth-slot';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function codexAuth(account: string, refresh: string) {
  const payload = Buffer.from(JSON.stringify({ sub: account, 'https://api.openai.com/auth': { chatgpt_account_id: 'w' } })).toString('base64url');
  return JSON.stringify({ tokens: { id_token: `h.${payload}.s`, refresh_token: refresh } });
}

async function slot() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-auth-slot-'));
  roots.push(dir);
  const paths: CodexAuthSlotPaths = { nativeRoot: join(dir, 'managed'), vaultRoot: (id) => join(dir, 'vaults', id),
    backupDir: join(dir, 'backup'), liveStateFile: join(dir, 'live.json') };
  for (const [root, text] of [[paths.nativeRoot, codexAuth('native', 'n')], [paths.vaultRoot('native'), codexAuth('native', 'n')],
    [paths.vaultRoot('gugu-a'), codexAuth('gugu-a', 'a')]] as const) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'auth.json'), text);
  }
  return { dir, paths };
}

// One session start resolves its connection from several places at once, within one millisecond of one process.
it('activates the same Codex account from concurrent session starts in one millisecond', async () => {
  const { dir, paths } = await slot();
  const ids = ['native', 'gugu-a'];
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  await Promise.all(Array.from({ length: 4 }, () => activateCodexAccount(paths, ids, 'gugu-a', 'native')));
  await Promise.all(Array.from({ length: 4 }, () => activateCodexAccount(paths, ids, 'gugu-a', 'gugu-a')));
  expect(await readFile(join(paths.nativeRoot, 'auth.json'), 'utf8')).toBe(codexAuth('gugu-a', 'a'));
  expect(await readFile(join(paths.vaultRoot('native'), 'auth.json'), 'utf8')).toBe(codexAuth('native', 'n'));
  expect(JSON.parse(await readFile(paths.liveStateFile, 'utf8'))).toMatchObject({ connectionId: 'gugu-a' });
  expect((await readdir(dir)).sort()).toEqual(['live.json', 'managed', 'vaults']);
  expect(await readdir(paths.nativeRoot)).toEqual(['auth.json']);
});
