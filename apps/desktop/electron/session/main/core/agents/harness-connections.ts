import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { eq } from 'drizzle-orm';
import { pluginRegistry, requireNativeHome } from '@gugu/session-plugins/agents';
import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import type {
  CreateHarnessConnection,
  HarnessConnection,
} from '@gugu/session-core/workspace-server/agent-config';
import { providerAccountRegistry as registry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import {
  activateClaudeAccount,
  copyClaudeUpgradeSignIn,
  restoreClaudeTerminalForMigration,
  claudeCredentialRoot,
  claudeSignInSaved,
  ensureClaudeVault,
  type ClaudeAuthSlotPaths,
} from './claude-auth-slot';
import { createClaudeCredentialStore, type ClaudeCredentialStore } from './claude-credential-store';
import { resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import {
  copyCodexUpgradeSignIn,
  assertCodexFileCredentialStore,
  codexAccountUsesLegacyRoot,
  bindLegacyCodexRootForLogin,
  ensureCodexVault,
  type CodexAuthSlotPaths,
} from './codex-auth-slot';
import {
  CLAUDE_CONNECTION_UNSET_ENV,
  CODEX_CONNECTION_UNSET_ENV,
} from './harness-connection-launch';
import { customModelRefFromOption } from '@gugu/session-core/models/custom-model';
import { migrateCustomModelConnections } from './custom-models';
import { reportAgentHomeMigrationFailure } from '../../../../error-summary-reporting-host';
import { loginShellEnv } from '@main/utils/userEnv';
import { nativeConfigRoot } from './native-config-root';
export { nativeConfigRoot };
import { nativeCodexAuthEnvironment, readNativeCodexOAuth } from './codex-native-auth-source';
import { reconcileCodexNativeReference } from './codex-native-auth-migration';
import { CODEX_NATIVE_AUTH_ROOT, codexOAuthIdentity } from '@gugu/core/local/codex-native-auth.mjs';

/** Subscription selection and credential routing for installed harnesses. */

type Provider = 'claude' | 'codex';

const namespace = (providerId: string) => `harness:${providerId}`;

/** Claude / Codex:账号连接 + API 连接,换凭据的代码逐家写(下面那一整套)。 */
function isAccountProvider(providerId: string): providerId is Provider {
  return providerId === 'claude' || providerId === 'codex';
}

function vendorKeyOf(providerId: string) {
  const auth = pluginRegistry.get(providerId)?.capabilities.auth;
  return auth?.kind === 'supported' ? auth.vendorKey : undefined;
}

/** 这一家能不能有连接 —— 只有主进程这一处判。 */
export function harnessHasConnections(providerId: string): boolean {
  return isAccountProvider(providerId) || vendorKeyOf(providerId) !== undefined;
}

function supported(providerId: string): void {
  if (!harnessHasConnections(providerId)) throw new Error('Connection management is unavailable for this harness');
}

type StoredConnection = NonNullable<NonNullable<Awaited<ReturnType<typeof registry.getAccount>>>['meta']>['harnessConnection'];

function connectionView(row: { accountId: string; isDefault: boolean; meta?: { displayName?: string; credentialSource?: string; harnessConnection?: StoredConnection } | null }): HarnessConnection {
  return {
    id: row.accountId,
    kind: row.meta?.credentialSource === 'vendor-key' || row.meta?.harnessConnection?.kind === 'account' ? 'account' : 'native',
    name: row.meta?.displayName ?? '',
    current: row.isDefault,
  };
}

async function ensureNative(providerId: string): Promise<void> {
  if (await registry.getAccount(namespace(providerId), 'native')) return;
  await registry.upsertAccount({
    providerId: namespace(providerId),
    accountId: 'native',
    meta: { harnessConnection: { kind: 'native' } },
  });
}

export async function listHarnessConnections(providerId: string): Promise<HarnessConnection[]> {
  supported(providerId);
  migrateCustomModelConnections();
  await ensureNative(providerId);
  if (providerId === 'codex') await reconcileNativeCodex();
  return (await registry.listAccounts(namespace(providerId)))
    .filter((row) => !row.meta?.harnessConnection?.removed && (row.meta?.harnessConnection?.kind !== 'api-key' || row.meta.credentialSource === 'vendor-key'))
    .map(connectionView);
}

export async function createHarnessConnection(input: CreateHarnessConnection): Promise<HarnessConnection> {
  supported(input.providerId);
  const vendor = vendorKeyOf(input.providerId);
  if (vendor ? !input.apiKey : input.apiKey) throw new Error(vendor ? 'An API key is required' : 'Account sign-in cannot include API credentials');
  const id = randomUUID();
  const name = input.name || `${pluginRegistry.get(input.providerId)!.metadata.name} ${(await listHarnessConnections(input.providerId)).length}`;
  if (isAccountProvider(input.providerId)) {
    if (input.providerId === 'codex') await ensureCodexVault(vaultRoot('codex', id));
    else await ensureClaudeVault(vaultRoot('claude', id));
  }
  await registry.upsertAccount({
    providerId: namespace(input.providerId), accountId: id,
    ...(vendor ? { secret: input.apiKey } : {}),
    meta: { displayName: name, ...(vendor ? { credentialSource: 'vendor-key' } : {}), harnessConnection: { kind: vendor ? 'api-key' : 'account' } },
  });
  return { id, name, kind: 'account', current: false };
}

/** Rename metadata on this device; never rewrite credentials or the selected account. */
export async function renameHarnessConnection(input: { providerId: string; connectionId: string; name: string }): Promise<HarnessConnection> {
  supported(input.providerId);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error('Connection name must contain 1–80 characters');
  const scope = namespace(input.providerId);
  const target = await registry.getAccount(scope, input.connectionId);
  if (!target || target.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
  const renamed = await registry.renameAccount(scope, input.connectionId, name);
  if (renamed.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
  return connectionView(renamed);
}

export async function selectHarnessConnection(
  providerId: string,
  connectionId: string,
  options: { nativeEnv?: Record<string, string | undefined> } = {}
): Promise<void> {
  supported(providerId);
  await ensureNative(providerId);
  await applyHarnessSelection(providerId, connectionId, options.nativeEnv);
}

async function applyHarnessSelection(
  providerId: string,
  connectionId: string,
  nativeEnv: Record<string, string | undefined> | undefined,
): Promise<void> {
  const target = await registry.getAccount(namespace(providerId), connectionId);
  if (!target || target.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
  if (providerId === 'claude' && target.meta?.harnessConnection?.kind !== 'api-key') {
    await activateClaudeAccount(claudeSlotPaths(nativeEnv), await accountConnectionIds(providerId), connectionId, await defaultConnectionId(providerId));
  }
  if (!(await registry.setDefaultAccount(namespace(providerId), connectionId))) {
    throw new Error('Connection no longer exists');
  }
}

/**
 * 切换前先看换不换得成(连接还在、它的登录还存着、Codex 的凭据在文件里):换不成就别先停掉在跑的会话,
 * 否则用户白白丢了进程、订阅还是旧的。只是预检,真正的切换仍在 `selectHarnessConnection` 里再判一次。
 */
export async function assertHarnessConnectionSelectable(
  providerId: string,
  connectionId: string,
  options: { nativeEnv?: Record<string, string | undefined> } = {}
): Promise<void> {
  supported(providerId);
  await ensureNative(providerId);
  const target = await registry.getAccount(namespace(providerId), connectionId);
  if (!target || target.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
  if (target.meta?.credentialSource === 'vendor-key' || !isAccountProvider(providerId)) return;
  if (providerId === 'codex') {
    // Returning to the native connection is also how the user returns to a signed-out state.
    if (connectionId === 'native') return;
    const auth = await readNativeCodexOAuth(await codexConnectionCredentialRoot(connectionId));
    const tokens = auth?.tokens as { access_token?: unknown } | undefined;
    if (codexOAuthIdentity(auth) && typeof tokens?.access_token === 'string' && tokens.access_token.trim()) return;
  } else if ((await claudeConnectionCredentialRoot(connectionId, options.nativeEnv)) === 'native'
    || await claudeSignInSaved(claudeSlotPaths(options.nativeEnv), connectionId)) return;
  throw new Error(`The selected ${providerId === 'codex' ? 'Codex' : 'Claude'} account has no saved sign-in; sign in to it again`);
}

/**
 * 任何连接都能删(#2507,owner 2026-11-12「删掉最后一个连接要能回到『没有』」)。删的是当前连接 ⇒ 先落回原生
 * (CLI 自己那一份;界面上它真有东西才列,没有就是「没有」),再拿掉它 —— ❌ 要人先切走:只剩它一个、
 * 原生又不列的时候根本没处可切。有别的连接也一样落回原生,❌ 替人挑下一个。
 *
 * 落回原生是一次切换:在跑的会话、「有会话在忙就不切」那道护栏归调用方(宿主先走 `switchSubscription`),
 * 这里只保证删完之后默认连接不会是一条已删的。
 */
export async function removeHarnessConnection(
  providerId: string,
  connectionId: string,
  options: { nativeEnv?: Record<string, string | undefined> } = {}
): Promise<void> {
  supported(providerId);
  if (connectionId === 'native') throw new Error('The existing CLI configuration cannot be removed');
  const target = await registry.getAccount(namespace(providerId), connectionId);
  if (!target || target.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
  if (target.isDefault) await selectHarnessConnection(providerId, 'native', options);
  // 只从列表里拿掉:保管目录里的登录仍归它,用户根里要是正好是它的账号,换走时还得写回去。API Key 连接的 key 随这一步删掉。
  await registry.retireAccount(namespace(providerId), connectionId,
    { ...target.meta, harnessConnection: { ...target.meta!.harnessConnection!, removed: true } });
}

/**
 * 登录进程跑在哪个连接上(#2507)。Claude / Codex 登的是指名的那个账号连接(原样)。
 * 其余家的账号只有它 CLI 自己那一份 ⇒ 恒是原生:CLI 自己的目录,❌ 默认连接 —— 选着一把 API Key 时,
 * 那把 key(环境变量 / 参数 / 「这是 API Key」的标记)也不进登录进程。没有连接的家原样(它的 run context 不看这一格)。
 */
export function harnessLoginConnectionId(providerId: string, connectionId: string | undefined): string | undefined {
  return vendorKeyOf(providerId) ? 'native' : connectionId;
}

function connectionHome(providerId: Provider, id: string): string {
  return join(app.getPath('userData'), 'harness-connections', providerId, id === 'native' ? 'managed-native' : id);
}

/** 连接的保管目录:布局与用户根相同(`<连接 home>/.claude` / `.codex`),登录与用量读取以它为配置根。 */
function vaultRoot(providerId: Provider, id: string): string {
  return join(connectionHome(providerId, id), requireNativeHome(providerId).userPath);
}

/**
 * 单一目录之前,Claude 账号 / API 连接上的会话跑在连接自己的配置根里,记录也在那里(就是今天的保管目录)。
 * 旧记录仍可从保管目录读取；不再在启动时向终端配置根搬运。原生连接与 Codex ⇒ null。
 */
export function connectionConfigRoot(providerId: string, connectionId: string): string | null {
  if (providerId !== 'claude' || connectionId === 'native') return null;
  return vaultRoot('claude', connectionId);
}

export function managedConfigRoot(providerId: Provider): string {
  const bundle = pluginRegistry.get(providerId)!.capabilities.sessionBundle!;
  return resolveAgentHome({ providerId, injectionMode: bundle.injectionMode, configRoot: bundle.configRoot,
    guguHome: process.env.GUGU_HOME ?? '', osHomeDir: homedir(), sourceEnv: process.env })!.configRoot;
}

function codexSlotPaths(_env?: Record<string, string | undefined>): CodexAuthSlotPaths {
  return {
    nativeRoot: managedConfigRoot('codex'),
    vaultRoot: (id) => vaultRoot('codex', id),
    backupDir: join(app.getPath('userData'), 'harness-connections', 'codex', 'unrecognized-sign-ins'),
    liveStateFile: join(app.getPath('userData'), 'harness-connections', 'codex', 'managed-live-account.json'),
  };
}

let claudeStore: ClaudeCredentialStore | null = null;

function claudeSlotPaths(_env?: Record<string, string | undefined>): ClaudeAuthSlotPaths {
  const nativeRoot = managedConfigRoot('claude');
  claudeStore ??= createClaudeCredentialStore();
  return {
    nativeRoot, nativeGlobalConfig: join(nativeRoot, '.claude.json'), nativeSuffixed: true,
    vaultRoot: (id) => vaultRoot('claude', id),
    backupDir: join(app.getPath('userData'), 'harness-connections', 'claude', 'unrecognized-sign-ins'),
    liveStateFile: join(app.getPath('userData'), 'harness-connections', 'claude', 'managed-live-account.json'),
    store: claudeStore,
  };
}

async function defaultConnectionId(providerId: Provider): Promise<string> {
  const id = await registry.getDefaultAccountId(namespace(providerId));
  const row = id ? await registry.getAccount(namespace(providerId), id) : null;
  return row?.meta?.harnessConnection?.migratedTo ? 'native' : id ?? 'native';
}

let nativeReconciliation: Promise<boolean> | undefined;
function reconcileNativeCodex(nativeEnv?: Record<string, string | undefined>): Promise<boolean> {
  if (nativeReconciliation) return nativeReconciliation;
  const env = nativeEnv ?? { ...process.env, ...loginShellEnv() };
  const paths = codexSlotPaths();
  const sourceRoot = nativeConfigRoot('codex', env);
  const work = (async () => {
    // An unsupported native store is not a file candidate. Explicit native status/login still reports its diagnostic;
    // it must not prevent using an unrelated Gugu account or merge a stale auth.json from that store.
    try { await assertCodexFileCredentialStore(sourceRoot); } catch { return false; }
    return reconcileCodexNativeReference({ sourceRoot, managedRoot: paths.nativeRoot,
    stateRoot: join(app.getPath('userData'), 'harness-connections', 'codex'), vaultRoot: paths.vaultRoot,
    rows: () => registry.listAccounts(namespace('codex')),
    commit: value => registry.commitCodexNativeReference(value),
    beforeMove: async () => { const { prepareSubscriptionMigration } = await import('../sessions/subscription-switch'); await prepareSubscriptionMigration('codex'); },
    });
  })();
  nativeReconciliation = work;
  void work.finally(() => { if (nativeReconciliation === work) nativeReconciliation = undefined; }).catch(() => undefined);
  return work;
}

/** 能把凭据换进用户根的连接:`native` 与账号连接(含已从列表移除的 —— 它的凭据仍归它)。 */
async function accountConnectionIds(providerId: Provider): Promise<string[]> {
  return (await registry.listAccounts(namespace(providerId)))
    .filter((row) => (row.meta?.harnessConnection?.kind ?? 'native') !== 'api-key')
    .map((row) => row.accountId);
}

async function claudeConnectionCredentialRoot(
  connectionId: string, nativeEnv?: Record<string, string | undefined>
): Promise<'native' | 'vault'> {
  return claudeCredentialRoot(claudeSlotPaths(nativeEnv), await accountConnectionIds('claude'), connectionId, await defaultConnectionId('claude'));
}

async function codexConnectionCredentialRoot(connectionId: string): Promise<string> {
  const paths = codexSlotPaths();
  return await codexAccountUsesLegacyRoot(paths, () => accountConnectionIds('codex'), connectionId)
    ? paths.nativeRoot : paths.vaultRoot(connectionId);
}

type HarnessConnectionInput = {
  connectionId?: string;
  sessionId?: string;
  sourceSessionId?: string;
  /** 解析「用户自己的配置根」用的 env(含用户 shell 里导出的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`)。 */
  nativeEnv?: Record<string, string | undefined>;
  forLogin?: boolean;
};

/** Resolved exclusively on the credential-owning machine, never in a renderer. */
export async function resolveHarnessConnection(
  providerId: string,
  input: HarnessConnectionInput = {},
): Promise<Partial<AgentRunContext>> {
  if (!isAccountProvider(providerId)) {
    const vendor = vendorKeyOf(providerId);
    if (!vendor) return {};
    migrateCustomModelConnections();
    const id = input.connectionId ?? (await registry.getDefaultAccountId(namespace(providerId))) ?? 'native';
    if (id === 'native') return {};
    const row = await registry.getAccount(namespace(providerId), id);
    if (row?.meta?.credentialSource !== 'vendor-key') throw new Error('The vendor account is unavailable');
    const secret = await registry.resolveSecret(namespace(providerId), id);
    if (!secret) throw new Error('The vendor account’s key is unavailable');
    return { connectionId: id, credentialEnv: Object.fromEntries(vendor.envVars.map((name) => [name, secret])), unsetEnv: [...vendor.unsetEnv], vendorKeyAccount: true };
  }
  await ensureNative(providerId);
  return resolveAccountHarnessConnection(providerId, input);
}

async function resolveAccountHarnessConnection(
  providerId: Provider,
  input: HarnessConnectionInput,
): Promise<Partial<AgentRunContext>> {
  // 会话(不论哪条、什么时候建的)和不指名的读取跟默认连接走;只有按连接问的(登录、登录状态、用量)才指名。
  const forSession = Boolean(input.sessionId) || !input.connectionId;
  const scope = namespace(providerId);
  let account = await registry.getAccount(scope, forSession ? undefined : input.connectionId);
  if (account?.meta?.harnessConnection?.migratedTo) account = await registry.getAccount(scope, 'native');
  if (!account) throw new Error(`The session’s subscription connection is unavailable (${scope}/${input.connectionId ?? 'default'})`);
  const id = account.accountId;
  if (providerId === 'codex') return resolveCodexConnection(id, account.meta?.harnessConnection, input);
  const unset = account.meta?.harnessConnection?.kind === 'account' ? { unsetEnv: [...CLAUDE_CONNECTION_UNSET_ENV] } : {};
  if (forSession || (await claudeConnectionCredentialRoot(id, input.nativeEnv)) === 'native') {
    return { connectionId: id, ...unset };
  }
  await ensureClaudeVault(vaultRoot('claude', id));
  return {
    connectionId: id, credentialHome: connectionHome('claude', id),
    configRootEnv: { [requireNativeHome('claude').envVar]: vaultRoot('claude', id) }, ...unset,
  };
}

async function resolveCodexConnection(
  id: string, details: StoredConnection, input: HarnessConnectionInput
): Promise<Partial<AgentRunContext>> {
  const env = Object.fromEntries(Object.entries(input.nativeEnv ?? { ...process.env, ...loginShellEnv() })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const unsetEnv = [...CODEX_CONNECTION_UNSET_ENV];
  const terminal = id === 'native' ? nativeConfigRoot('codex', env) : undefined;
  if (input.forLogin && terminal) {
    return { connectionId: id, unsetEnv, configRootEnv: { CODEX_HOME: terminal } };
  }
  if (terminal) {
    const credentialEnv = await nativeCodexAuthEnvironment(terminal, env);
    if (credentialEnv) return { connectionId: id, credentialEnv, unsetEnv };
    if (details?.nativeOAuth) {
      return { connectionId: id, credentialEnv: { [CODEX_NATIVE_AUTH_ROOT]: terminal }, unsetEnv };
    }
  }

  const stored = await codexConnectionCredentialRoot(id);
  const managed = managedConfigRoot('codex');
  if (input.forLogin) {
    if (stored === managed) await bindLegacyCodexRootForLogin(codexSlotPaths(), id);
    else await ensureCodexVault(stored);
    return {
      connectionId: id, unsetEnv, configRootEnv: { CODEX_HOME: stored },
      ...(stored !== managed ? { credentialHome: connectionHome('codex', id) } : {}),
    };
  }
  // Conversations keep the managed history root; only the account-specific auth route changes.
  const credentialEnv = await nativeCodexAuthEnvironment(stored, env);
  if (credentialEnv || stored !== managed || id !== 'native') {
    return { connectionId: id, credentialEnv: credentialEnv ?? { [CODEX_NATIVE_AUTH_ROOT]: stored }, unsetEnv };
  }
  // New installations with no saved file can still use the native CLI's usual sign-in flow.
  return { connectionId: id };
}

/** An event must be attributed to the account the session actually ran on, never a guess. */
export async function sessionHarnessConnectionId(sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) return undefined;
  const custom = customModelRefFromOption(row.config?.model);
  if (custom) return custom.connectionId;
  // Subscription sessions follow the current default; custom-model sessions are handled above.
  if (row.provider === 'codex' || row.provider === 'claude') return defaultConnectionId(row.provider);
  if (row.provider && vendorKeyOf(row.provider)) return (await registry.getDefaultAccountId(namespace(row.provider))) ?? 'native';
  return 'native';
}

type RestoredTerminal = {
  relogin: string | null;
  terminalNeedsSignIn: boolean;
  legacyVaultUnverified?: boolean;
  moved?: { connectionId: string; identity: string };
};

/** Split the old shared slot and use the compatibility copy only for an existing installation. */
export async function migrateOwnedHarnessAccounts(providerId: Provider, env: Record<string, string | undefined>, automatic = false): Promise<{
  terminalNeedsSignIn: boolean; relogin: { connectionId: string; name: string; methodId: string }[];
  upgradeSignIn?: 'copied' | 'relogin' | 'reference';
}> {
  if (providerId === 'codex') {
    await ensureNative(providerId);
    try {
      await assertCodexFileCredentialStore(nativeConfigRoot('codex', env));
      if (await reconcileNativeCodex(env)) return { terminalNeedsSignIn: false, relogin: [], upgradeSignIn: 'reference' as const };
      // OAuth is never copied, restored, or written into the terminal directory. API keys keep the old copy path.
      if (automatic) {
        const managed = codexSlotPaths();
        const copied = await copyCodexUpgradeSignIn({ ...managed, nativeRoot: nativeConfigRoot('codex', env) }, managed, 'native');
        if (copied === false) return { terminalNeedsSignIn: false, relogin: [], upgradeSignIn: 'relogin' };
      }
      return { terminalNeedsSignIn: false, relogin: [] };
    } catch (error) {
      if (!automatic) throw error;
      reportAgentHomeMigrationFailure(error, 'sign-in');
      return { terminalNeedsSignIn: false, relogin: [], upgradeSignIn: 'relogin' as const };
    }
  }
  const ids = await accountConnectionIds(providerId);
  const selected = await defaultConnectionId(providerId);
  const account = await registry.getAccount(namespace(providerId), selected);
  const owned = account?.meta?.harnessConnection?.kind === 'account';
  const formerRoot = nativeConfigRoot(providerId, env);
  const stateDir = join(app.getPath('userData'), 'harness-connections', providerId);
  const oldNativeVault = join(stateDir, 'native', requireNativeHome(providerId).userPath);
  const previousVaultRoot = (id: string) => id === 'native' ? oldNativeVault : vaultRoot(providerId, id);
  const liveStateFile = join(stateDir, 'live-account.json');
  const finish = async (restore: () => Promise<RestoredTerminal>, activate: () => Promise<unknown>, copy: (vaultIdentity?: string) => Promise<'oauth' | 'api-key' | false | undefined>) => {
    let result: RestoredTerminal = { relogin: null, terminalNeedsSignIn: false };
    try {
      const { prepareSubscriptionMigration } = await import('../sessions/subscription-switch');
      await prepareSubscriptionMigration(providerId);
      result = await restore();
      if (owned && result.relogin !== selected) {
        await activate();
        return migrationNotice(providerId, result);
      }
    } catch (error) {
      if (!automatic) throw error;
      log.warn('Could not split the previous account slot during upgrade', { providerId });
      reportAgentHomeMigrationFailure(error, 'sign-in');
    }
    let upgradeSignIn: 'copied' | 'relogin' | undefined;
    if (automatic && (owned || selected === 'native')) {
      try {
        // If B is already back in the terminal, the old in-use sign-in is the verified A now in its vault.
        const copied = await copy(result.moved?.connectionId === selected ? result.moved.identity : undefined);
        upgradeSignIn = copied === 'oauth' ? 'copied' : copied === false ? 'relogin' : undefined;
      }
      catch (error) {
        log.warn('Could not transfer the previous sign-in during upgrade', { providerId });
        reportAgentHomeMigrationFailure(error, 'sign-in');
        upgradeSignIn = 'relogin';
      }
    }
    const notice = await migrationNotice(providerId, result);
    return upgradeSignIn ? { ...notice, upgradeSignIn } : notice;
  };
  {
    const managed = claudeSlotPaths();
    const exported = Boolean(env.CLAUDE_CONFIG_DIR?.trim());
    const previous = { ...managed, nativeRoot: formerRoot, nativeSuffixed: exported, vaultRoot: previousVaultRoot,
      nativeGlobalConfig: exported ? join(formerRoot, '.claude.json') : join(homedir(), '.claude.json'),
      liveStateFile };
    return finish(() => restoreClaudeTerminalForMigration(previous, ids),
      () => activateClaudeAccount(managed, ids, selected, 'native'),
      async (vaultIdentity) => {
        const root = previous.vaultRoot(selected);
        const copied = await copyClaudeUpgradeSignIn(vaultIdentity ? {
          ...previous, nativeRoot: root, nativeGlobalConfig: join(root, '.claude.json'), nativeSuffixed: true,
        } : previous, managed, selected, vaultIdentity);
        return copied ? 'oauth' : copied;
      });
  }
}

async function migrationNotice(providerId: Provider, result: RestoredTerminal) {
  if (result.legacyVaultUnverified) log.warn('Skipped legacy native vault cleanup because the terminal identity could not be verified', { providerId });
  const account = result.relogin ? await registry.getAccount(namespace(providerId), result.relogin) : null;
  const auth = pluginRegistry.get(providerId)?.capabilities.auth;
  const method = auth?.kind === 'supported' ? auth.methods.find((method) => method.kind === 'cli-login') : undefined;
  return { terminalNeedsSignIn: result.terminalNeedsSignIn,
    relogin: account && method ? [{ connectionId: account.accountId, name: account.meta?.displayName ?? account.accountId, methodId: method.id }] : [] };
}
