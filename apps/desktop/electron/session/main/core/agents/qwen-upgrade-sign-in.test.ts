import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrateQwenUpgradeSignIn } from './qwen-upgrade-sign-in';

let root: string;
let source: string;
let target: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qwen-upgrade-auth-'));
  source = join(root, 'source');
  target = join(root, 'target');
  await Promise.all([mkdir(source), mkdir(target)]);
});
afterEach(() => rm(root, { recursive: true, force: true }));

it('copies reusable model keys into a private file and leaves runtime overrides and the source intact', async () => {
  const env = 'QWEN_HOME=/old/path\nCUSTOM_API_KEY=mock-custom\nBAILIAN_CODING_PLAN_API_KEY=mock-plan\nOPENAI_BASE_URL=https://models.example.test/v1\n';
  await writeFile(join(source, '.env'), env);
  await writeFile(join(target, 'settings.json'), JSON.stringify({ modelProviders: { openai: [{ envKey: 'CUSTOM_API_KEY' }] } }));
  expect(await migrateQwenUpgradeSignIn(source, target)).toBe('copied');
  expect(parseEnv(await readFile(join(target, '.env'), 'utf8'))).toEqual({
    CUSTOM_API_KEY: 'mock-custom', BAILIAN_CODING_PLAN_API_KEY: 'mock-plan', OPENAI_BASE_URL: 'https://models.example.test/v1',
  });
  if (process.platform !== 'win32') expect((await stat(join(target, '.env'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(source, '.env'), 'utf8')).toBe(env);
});

it('requires a separate OAuth sign-in and preserves a different managed credential', async () => {
  await writeFile(join(source, 'oauth_creds.json'), 'synthetic OAuth credentials');
  await writeFile(join(source, '.env'), 'OPENAI_API_KEY=mock-old\n');
  await writeFile(join(target, '.env'), 'OPENAI_API_KEY=mock-managed\n');
  expect(await migrateQwenUpgradeSignIn(source, target)).toBe('relogin');
  await expect(readFile(join(target, 'oauth_creds.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(target, '.env'), 'utf8')).toBe('OPENAI_API_KEY=mock-managed\n');
});

it('imports native file auth on upgrade without replacing managed settings', async () => {
  await writeFile(join(source, 'settings.json'), '{"security":{"auth":{"selectedType":"openai","apiKey":"mock-key"}}}');
  await writeFile(join(target, 'settings.json'), '{"ui":{"theme":"default"}}');
  expect(await migrateQwenUpgradeSignIn(source, target)).toBe('copied');
  expect(JSON.parse(await readFile(join(target, 'settings.json'), 'utf8'))).toEqual({
    ui: { theme: 'default' }, security: { auth: { selectedType: 'openai', apiKey: 'mock-key' } },
  });
});
