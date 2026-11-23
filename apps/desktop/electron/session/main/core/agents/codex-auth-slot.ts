import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { KeyedMutex } from '@gugu/session-core/lib';
import { parse as parseTOML } from 'smol-toml';

/**
 * Codex sessions and account switching share one Gugu-owned config root.
 *
 * 每个 OAuth 账号同一时刻只有**一份**权威凭据:正在用的那个在托管根里(CLI 会原地刷新、轮换 refresh
 * token),其余的在各自的保管目录 `<连接 home>/.codex/auth.json`。换出时先把活动根里那份(已轮换过的)
 * 写回它的主人,再换入新的 —— 否则主人手里那份 refresh token 已经作废,下次换回来就得重新登录。
 *
 * 只支持 `cli_auth_credentials_store = "file"`(Codex 的缺省)。凭据在系统钥匙串里时,钥匙串条目按
 * 配置根路径的哈希命名,换文件换不动它 —— 当场报错,❌ 不假装换成功。
 */

export type CodexAuthSlotPaths = {
  /** Active Codex config root. Migration alone opens the former shared root. */
  nativeRoot: string;
  /** Inactive sign-ins, including the managed root's own native sign-in. */
  vaultRoot(connectionId: string): string;
  /** 活动根里出现了谁都不认识的账号(用户在终端里自己 `codex login` 过)时,换出前留一份副本在这里。 */
  backupDir: string;
  /** 记下上一次换进活动根的是哪个连接、哪个账号(不含凭据)。 */
  liveStateFile: string;
};

type LiveState = { connectionId: string; identity: string; nativeVaultCleanup?: true };
const activationLock = new KeyedMutex();

async function readLiveState(path: string): Promise<LiveState | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LiveState> | null;
    return value && typeof value.connectionId === 'string' && typeof value.identity === 'string'
      ? { connectionId: value.connectionId, identity: value.identity,
          ...(value.nativeVaultCleanup === true ? { nativeVaultCleanup: true as const } : {}) }
      : null;
  } catch {
    return null;
  }
}

function recordLiveState(path: string, state: LiveState): Promise<void> {
  return replacePrivateFile(path, `${JSON.stringify(state)}\n`);
}

const AUTH_FILE = 'auth.json';

/** 账号身份:同一个 ChatGPT 工作区里可以有好几个人,所以「人 + 工作区」一起算。 */
export function codexAuthIdentity(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as { auth_mode?: unknown; OPENAI_API_KEY?: unknown };
  const mode = doc.auth_mode ?? (doc.OPENAI_API_KEY != null ? 'apikey' : 'chatgpt');
  if (mode === 'apikey') {
    const key = doc.OPENAI_API_KEY;
    return typeof key === 'string' && key.trim() ? `apikey:${createHash('sha256').update(key.trim()).digest('hex').slice(0, 16)}` : null;
  }
  if (mode !== 'chatgpt') return null;
  const tokens = (raw as { tokens?: unknown }).tokens;
  if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
    const claims = jwtClaims((tokens as { id_token?: unknown }).id_token);
    const auth = claims?.['https://api.openai.com/auth'];
    const workspace =
      (auth && typeof auth === 'object' ? (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id : undefined) ??
      (tokens as { account_id?: unknown }).account_id;
    const subject = claims?.sub;
    if (typeof subject === 'string' && subject) return `chatgpt:${subject}|${typeof workspace === 'string' ? workspace : ''}`;
  }
  return null;
}

function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readAuth(root: string): Promise<{ text: string; identity: string | null } | null> {
  let text: string;
  try {
    text = await readFile(join(root, AUTH_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return { text, identity: codexAuthIdentity(JSON.parse(text)) };
  } catch {
    return { text, identity: null };
  }
}

function writeAuth(root: string, text: string): Promise<void> {
  return replacePrivateFile(join(root, AUTH_FILE), text);
}

/** Publish a complete file by renaming a temporary file owned by this write. */
async function replacePrivateFile(target: string, text: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.gugu-${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(text);
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 活动根的凭据不在 auth.json 里时,换文件等于什么都没换。 */
export async function assertCodexFileCredentialStore(nativeRoot: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(nativeRoot, 'config.toml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let store: unknown;
  try {
    store = parseTOML(raw).cli_auth_credentials_store;
  } catch {
    throw new Error(`Cannot read ${join(nativeRoot, 'config.toml')}; Codex subscriptions were not switched`);
  }
  if (store !== undefined && store !== 'file') {
    throw new Error(
      `Codex keeps its sign-in in "${String(store)}" storage (cli_auth_credentials_store); ` +
        'switching Codex subscriptions requires the default "file" storage'
    );
  }
}

/**
 * 活动根里此刻是哪个连接的账号。`selectedId` = 调用方认为当前选中的连接。
 *
 * 0. 上一次换进去的记录,账号还对得上 ⇒ 就是它。❌ 只靠「选中的」:选中 API 连接之后再选回账号 A,
 *    选中的是 API 连接,判不出活动根里是 A。
 * 1. 选中的是账号连接,且它保管的账号和活动根里的一致 ⇒ 就是它(升级前没有记录时靠这条)。❌ 放到 2 之后:
 *    新用户原生没登录、先加了账号 A,这时活动根里是 A,若判成 native,换出时 A 轮换过的 token 会被存到 native 名下。
 * 2. `native` 还没有保管副本 = 还没换出过,活动根里的就是它:用户又把同一个账号加成了账号连接时,
 *    按身份会先撞上那个连接,于是原生连接永远「不在活动根里」、又没有副本,再也选不回去。
 *    同一个账号既是原生又是某个连接时也归原生:两边的凭据本来就是同一个人的。
 * 3. 否则按身份在所有连接里找。
 */
async function resolveLiveOwner(
  paths: CodexAuthSlotPaths,
  connectionIds: readonly string[],
  selectedId: string | null,
  identity: string | null,
  recorded: LiveState | null,
): Promise<string | null> {
  if (identity && recorded?.identity === identity && connectionIds.includes(recorded.connectionId)) {
    return recorded.connectionId;
  }
  if (selectedId && selectedId !== 'native' && identity) {
    if ((await readAuth(paths.vaultRoot(selectedId)))?.identity === identity) return selectedId;
  }
  const native = await readAuth(paths.vaultRoot('native'));
  if (!native) return 'native';
  if (!identity) return null;
  if (native.identity === identity) return 'native';
  for (const id of connectionIds) {
    if (id !== 'native' && (await readAuth(paths.vaultRoot(id)))?.identity === identity) return id;
  }
  return null;
}

export async function codexLiveOwner(
  paths: CodexAuthSlotPaths,
  connectionIds: readonly string[],
  selectedId: string | null,
): Promise<string | null> {
  const live = await readAuth(paths.nativeRoot);
  const recorded = await readLiveState(paths.liveStateFile);
  return resolveLiveOwner(paths, connectionIds, selectedId, live?.identity ?? null, recorded);
}

/** 读某个连接的凭据该去哪个根:它的账号此刻在活动根里就读活动根(那份才是最新的),否则读它的保管目录。 */
export async function codexCredentialRoot(
  paths: CodexAuthSlotPaths,
  connectionIds: readonly string[],
  connectionId: string,
  selectedId: string | null
): Promise<'native' | 'vault'> {
  return (await codexLiveOwner(paths, connectionIds, selectedId)) === connectionId ? 'native' : 'vault';
}

/**
 * 把活动根换成 `targetId` 的账号。`connectionIds` = 全部 OAuth 连接(含 `native`),`currentId` = 换之前选中的连接。
 * 返回换之前活动根属于谁(`null` = 不认识的账号,已另存副本)。
 */
export async function activateCodexAccount(
  paths: CodexAuthSlotPaths,
  connectionIds: readonly string[],
  targetId: string,
  currentId: string | null,
  now: () => Date = () => new Date(),
  migration?: { allowEmptyNative: true; verifySource: () => Promise<void> }
): Promise<string | null> {
  // Startup and model probes share the same slot. Decide ownership inside the
  // lock so a second caller sees the credentials and record committed by the first.
  return activationLock.runExclusive(paths.liveStateFile, async () => {
    await assertCodexFileCredentialStore(paths.nativeRoot);
    const identity = (await readAuth(paths.nativeRoot))?.identity ?? null;
    const recorded = await readLiveState(paths.liveStateFile);
    const owner = await resolveLiveOwner(paths, connectionIds, currentId, identity, recorded);
    if (migration && owner !== currentId) throw new Error('Codex is in use; retry migration later');
    if (owner === targetId) {
      // Older installs may have the right credentials without a matching ownership record.
      if (identity && (recorded?.connectionId !== targetId || recorded.identity !== identity)) {
        await recordLiveState(paths.liveStateFile, { connectionId: targetId, identity });
      }
      return owner;
    }
    const incoming = await readAuth(paths.vaultRoot(targetId));
    const restoringTerminal = Boolean(migration && targetId === 'native');
    if ((!incoming && !restoringTerminal) || (restoringTerminal && incoming && !incoming.identity)) {
      throw new Error('The selected Codex account has no saved sign-in; sign in to it again');
    }
    const live = await readAuth(paths.nativeRoot);
    const savedOwner = owner ? await readAuth(paths.vaultRoot(owner)) : null;
    const savedState = await readFile(paths.liveStateFile, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    let changedLive = false;
    try {
      if (live) {
        if (owner) {
          await writeAuth(paths.vaultRoot(owner), live.text);
        } else {
          await mkdir(paths.backupDir, { recursive: true, mode: 0o700 });
          await copyFile(join(paths.nativeRoot, AUTH_FILE), join(paths.backupDir, `auth-${now().toISOString().replace(/[:.]/g, '-')}.json`));
        }
      }
      await migration?.verifySource();
      if (incoming) await writeAuth(paths.nativeRoot, incoming.text);
      else await rm(join(paths.nativeRoot, AUTH_FILE), { force: true });
      changedLive = true;
      if (incoming?.identity || restoringTerminal) {
        await recordLiveState(paths.liveStateFile, { connectionId: targetId, identity: incoming?.identity ?? '',
          ...(restoringTerminal && incoming ? { nativeVaultCleanup: true } : {}) });
      } else await rm(paths.liveStateFile, { force: true });
    } catch (error) {
      if (savedState !== null) await replacePrivateFile(paths.liveStateFile, savedState);
      else await rm(paths.liveStateFile, { force: true });
      // A source guard rejection happened before changing the terminal slot.
      if (changedLive && (await readAuth(paths.nativeRoot))?.text === incoming?.text) {
        if (live) await writeAuth(paths.nativeRoot, live.text);
        else await rm(join(paths.nativeRoot, AUTH_FILE), { force: true });
      }
      if (owner) {
        if (savedOwner) await writeAuth(paths.vaultRoot(owner), savedOwner.text);
        else await rm(join(paths.vaultRoot(owner), AUTH_FILE), { force: true });
      }
      throw error;
    }
    return owner;
  });
}

async function cleanRestoredCodexVault(paths: CodexAuthSlotPaths, recorded: LiveState): Promise<boolean> {
  if (!recorded.identity) return false;
  const legacyRoot = paths.vaultRoot('native');
  const saved = await readAuth(legacyRoot);
  if (saved) {
    if (saved.identity !== recorded.identity || (await readAuth(paths.nativeRoot))?.identity !== recorded.identity ||
      await realpath(paths.nativeRoot) === await realpath(legacyRoot)) {
      if (recorded.nativeVaultCleanup) throw new Error('Could not verify the restored Codex terminal sign-in; retry migration');
      return true;
    }
    await rm(join(legacyRoot, AUTH_FILE));
  }
  if (recorded.nativeVaultCleanup) await recordLiveState(paths.liveStateFile, { connectionId: 'native', identity: recorded.identity });
  return false;
}

/** Only a recorded, registered Gugu account can be moved out of the former shared slot. */
export async function restoreCodexTerminalForMigration(paths: CodexAuthSlotPaths, ids: readonly string[]) {
  const recorded = await readLiveState(paths.liveStateFile);
  if (!recorded) return { terminalNeedsSignIn: false, relogin: null };
  if (recorded.connectionId === 'native') {
    const legacyVaultUnverified = await cleanRestoredCodexVault(paths, recorded);
    return { terminalNeedsSignIn: recorded.identity === '', relogin: null, ...(legacyVaultUnverified ? { legacyVaultUnverified } : {}) };
  }
  if (!ids.includes(recorded.connectionId)) return { terminalNeedsSignIn: false, relogin: recorded.connectionId };
  const live = await readAuth(paths.nativeRoot);
  if (!live?.identity || live.identity !== recorded.identity) return { terminalNeedsSignIn: false, relogin: recorded.connectionId };
  const before = await stat(join(paths.nativeRoot, AUTH_FILE));
  await activateCodexAccount(paths, ids, 'native', recorded.connectionId, undefined, {
    allowEmptyNative: true,
    verifySource: async () => {
      const current = await readAuth(paths.nativeRoot), after = await stat(join(paths.nativeRoot, AUTH_FILE));
      if (current?.text !== live.text || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        throw new Error('Codex is in use; retry migration later');
      }
    },
  });
  const restored = await readLiveState(paths.liveStateFile);
  if (!restored || restored.connectionId !== 'native') throw new Error('Could not verify the restored Codex terminal sign-in; retry migration');
  await cleanRestoredCodexVault(paths, restored);
  return { terminalNeedsSignIn: restored.identity === '', relogin: null, moved: recorded };
}

/** Copy API-key sign-ins only. An OAuth refresh token must have one owner. */
export async function copyCodexUpgradeSignIn(
  previous: CodexAuthSlotPaths, managed: CodexAuthSlotPaths, connectionId: string, vaultIdentity?: string,
): Promise<'api-key' | false | undefined> {
  await assertCodexFileCredentialStore(previous.nativeRoot);
  await assertCodexFileCredentialStore(managed.nativeRoot);
  const state = await readLiveState(previous.liveStateFile);
  const live = await readAuth(previous.nativeRoot);
  if (!live && connectionId === 'native') return undefined;
  if (!live?.identity) return false;
  if (vaultIdentity ? live.identity !== vaultIdentity
    : connectionId !== 'native' && (state?.connectionId !== connectionId || state.identity !== live.identity)) return false;
  if (live.identity.startsWith('chatgpt:')) return false;
  const target = await readAuth(managed.nativeRoot);
  if (target && target.identity !== live.identity) return false;
  const parsed = JSON.parse(live.text) as { tokens?: unknown; OPENAI_API_KEY: string };
  // An inactive OAuth field in a mixed API-key document must not duplicate its refresh token.
  if (!target) await writeAuth(managed.nativeRoot, parsed.tokens ? JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: parsed.OPENAI_API_KEY }) : live.text);
  else {
    const existing = JSON.parse(target.text) as { tokens?: unknown; OPENAI_API_KEY: string };
    if (existing.tokens) await writeAuth(managed.nativeRoot, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: existing.OPENAI_API_KEY }));
  }
  await recordLiveState(managed.liveStateFile, { connectionId, identity: live.identity });
  return 'api-key';
}

/** 这个连接的保管目录里有没有一份能换进来的登录(切换前先问,免得白白停掉在跑的会话)。 */
export async function codexSignInSaved(paths: CodexAuthSlotPaths, connectionId: string): Promise<boolean> {
  return (await readAuth(paths.vaultRoot(connectionId))) !== null;
}

/** 保管目录也要是一份能独立跑 `codex login` / `login status` 的根:凭据只落文件,❌ 落进钥匙串。 */
export async function ensureCodexVault(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    }
  );
}
