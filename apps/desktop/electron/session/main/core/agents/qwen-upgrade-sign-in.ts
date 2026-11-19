import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { parse, type ParseError } from 'jsonc-parser';

const MAX_FILE_BYTES = 1024 * 1024;
const KNOWN_KEYS = [
  'BAILIAN_CODING_PLAN_API_KEY', 'BAILIAN_TOKEN_PLAN_API_KEY', 'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
];
const MODEL_ENV = [
  'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_MODEL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'GEMINI_MODEL', 'GOOGLE_MODEL', 'QWEN_MODEL', 'QWEN_DEFAULT_AUTH_TYPE',
];

type Settings = {
  security?: { auth?: { selectedType?: string; apiKey?: string; useExternal?: boolean } };
  modelProviders?: Record<string, { envKey?: string }[]>;
};

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

async function readSignInFile(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    .catch((error: unknown) => { if (missing(error)) return undefined; throw error; });
  if (!file) return undefined;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error('Invalid Qwen sign-in file');
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(buffer);
    const after = await file.stat();
    if (bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      throw new Error('Qwen sign-in file changed during migration');
    }
    return buffer.toString('utf8', 0, bytesRead);
  } finally { await file.close(); }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: unknown) => { if (missing(error)) return false; throw error; });
}

function parseSettings(content: string | undefined): Settings {
  if (content === undefined) return {};
  const errors: ParseError[] = [];
  const settings: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Invalid Qwen settings during sign-in migration');
  }
  return settings as Settings;
}

/** The security settings contain native login data. Only the one-time upgrade imports them. */
async function migrateSecuritySettings(source: string, target: string, settingsFile: string | undefined, settings: Settings) {
  const nativeFile = await realpath(join(source, 'settings.json'))
    .catch((error: unknown) => { if (missing(error)) return undefined; throw error; });
  const previous = parseSettings(nativeFile ? await readSignInFile(nativeFile) : undefined).security;
  if (!previous) return { auth: settings.security?.auth, conflicting: false };
  const security = { ...previous, ...settings.security };
  const conflicting = Boolean(previous.auth && settings.security?.auth
    && previous.auth.apiKey !== settings.security.auth.apiKey);
  if (JSON.stringify(security) !== JSON.stringify(settings.security)) {
    const destination = join(target, 'settings.json');
    const temporary = join(target, `.qwen-settings-${randomUUID()}`);
    try {
      await writeFile(temporary, JSON.stringify({ ...settings, security }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      if (settingsFile === undefined) await link(temporary, destination);
      else {
        if (await readSignInFile(destination) !== settingsFile) throw new Error('Managed Qwen settings changed during sign-in migration');
        await rename(temporary, destination);
      }
    } finally { await rm(temporary, { force: true }); }
  }
  return { auth: security.auth, conflicting };
}

/** Copy reusable file-based API keys without activating other dotenv entries in the managed home. */
export async function migrateQwenUpgradeSignIn(source: string, target: string): Promise<'copied' | 'relogin' | undefined> {
  const [settingsFile, oldEnv, qwenOAuth, mcpOAuth] = await Promise.all([
    readSignInFile(join(target, 'settings.json')),
    readSignInFile(join(source, '.env')),
    exists(join(source, 'oauth_creds.json')),
    exists(join(source, 'mcp-oauth-tokens.json')),
  ]);
  const settings = parseSettings(settingsFile);
  const { auth, conflicting } = await migrateSecuritySettings(source, target, settingsFile, settings);
  const original = parseEnv(oldEnv ?? '');
  // Qwen and MCP OAuth tokens can rotate. The two homes cannot share their refresh lock.
  let separateLogin = conflicting || qwenOAuth || mcpOAuth || auth?.selectedType === 'qwen-oauth' || auth?.useExternal;
  const keys = new Set(KNOWN_KEYS);
  for (const providers of Object.values(settings.modelProviders ?? {})) {
    if (!Array.isArray(providers)) continue;
    for (const { envKey } of providers) {
      if (typeof envKey !== 'string' || !Object.hasOwn(original, envKey) || !original[envKey]) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*(?:_KEY|_TOKEN)$/.test(envKey)) keys.add(envKey);
      else separateLogin = true;
    }
  }
  const selected = [...keys, ...MODEL_ENV].filter((key) => Object.hasOwn(original, key) && original[key]);
  if (!selected.length) return separateLogin ? 'relogin' : auth?.apiKey ? 'copied' : undefined;

  const contents = selected.map((key) => `${key}=${JSON.stringify(original[key])}\n`).join('');
  const roundTrip = parseEnv(contents);
  if (selected.some((key) => roundTrip[key] !== original[key])) return 'relogin';
  const destination = join(target, '.env');
  const temporary = join(target, `.qwen-sign-in-${randomUUID()}`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    try { await link(temporary, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const managed = parseEnv(await readSignInFile(destination) ?? '');
      if (selected.some((key) => managed[key] !== original[key])) return 'relogin';
    }
  } finally { await rm(temporary, { force: true }); }
  return separateLogin ? 'relogin' : auth?.apiKey || selected.some((key) => keys.has(key)) ? 'copied' : undefined;
}
