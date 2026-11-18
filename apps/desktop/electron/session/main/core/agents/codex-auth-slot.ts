import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

async function recordLiveState(path: string, state: LiveState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.gugu-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

const AUTH_FILE = 'auth.json';

/** 账号身份:同一个 ChatGPT 工作区里可以有好几个人,所以「人 + 工作区」一起算。 */
export function codexAuthIdentity(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
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
  const key = (raw as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY;
  if (typeof key === 'string' && key.trim()) return `apikey:${createHash('sha256').update(key.trim()).digest('hex').slice(0, 16)}`;
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

/** 先写临时文件再改名:换到一半崩了,活动根里要么是旧账号、要么是新账号,❌ 半个文件。 */
async function writeAuth(root: string, text: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, AUTH_FILE);
  const temporary = `${target}.gugu-${process.pid}-${Date.now()}`;
  await writeFile(temporary, text, { mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
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
export async function codexLiveOwner(
  paths: CodexAuthSlotPaths,
  connectionIds: readonly string[],
  selectedId: string | null
): Promise<string | null> {
  const live = await readAuth(paths.nativeRoot);
  const recorded = await readLiveState(paths.liveStateFile);
  if (live?.identity && recorded?.identity === live.identity && connectionIds.includes(recorded.connectionId)) {
    return recorded.connectionId;
  }
  if (selectedId && selectedId !== 'native' && live?.identity) {
    if ((await readAuth(paths.vaultRoot(selectedId)))?.identity === live.identity) return selectedId;
  }
  const native = await readAuth(paths.vaultRoot('native'));
  if (!native) return 'native';
  if (!live?.identity) return null;
  if (native.identity === live.identity) return 'native';
  for (const id of connectionIds) {
    if (id !== 'native' && (await readAuth(paths.vaultRoot(id)))?.identity === live.identity) return id;
  }
  return null;
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
  await assertCodexFileCredentialStore(paths.nativeRoot);
  const owner = await codexLiveOwner(paths, connectionIds, currentId);
  if (migration && owner !== currentId) throw new Error('Codex is in use; retry migration later');
  // 已经在活动根里(含「用户从没登录过,原生连接就是空的」):什么都不用搬,把记录对齐即可。
  if (owner === targetId) {
    const identity = (await readAuth(paths.nativeRoot))?.identity;
    if (identity) await recordLiveState(paths.liveStateFile, { connectionId: targetId, identity });
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
    if (savedState !== null) await writeFile(paths.liveStateFile, savedState, { mode: 0o600 });
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
  return { terminalNeedsSignIn: restored.identity === '', relogin: null };
}

/** A one-time snapshot of the sign-in used before an upgrade. It never changes the source slot. */
export async function copyCodexUpgradeSignIn(previous: CodexAuthSlotPaths, managed: CodexAuthSlotPaths, connectionId: string): Promise<boolean | undefined> {
  await assertCodexFileCredentialStore(previous.nativeRoot);
  await assertCodexFileCredentialStore(managed.nativeRoot);
  const state = await readLiveState(previous.liveStateFile);
  const live = await readAuth(previous.nativeRoot);
  if (!live && connectionId === 'native') return undefined;
  if (!live?.identity?.startsWith('chatgpt:')) return false;
  if (connectionId !== 'native' && (state?.connectionId !== connectionId || state.identity !== live.identity)) return false;
  const target = await readAuth(managed.nativeRoot);
  if (target && target.identity !== live.identity) return false;
  if (!target) {
    const credentials = JSON.parse(live.text) as Record<string, unknown>;
    await writeAuth(managed.nativeRoot, JSON.stringify({ ...credentials, OPENAI_API_KEY: null }));
  }
  await recordLiveState(managed.liveStateFile, { connectionId, identity: live.identity });
  return true;
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
