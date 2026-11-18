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
  activateCodexAccount,
  copyCodexUpgradeSignIn,
  restoreCodexTerminalForMigration,
  assertCodexFileCredentialStore,
  codexCredentialRoot,
  codexSignInSaved,
  ensureCodexVault,
  type CodexAuthSlotPaths,
} from './codex-auth-slot';
import {
  CLAUDE_CONNECTION_UNSET_ENV,
  CODEX_CONNECTION_UNSET_ENV,
} from './harness-connection-launch';
import { customModelRefFromOption } from '@gugu/session-core/models/custom-model';
import { migrateCustomModelConnections } from './custom-models';

/** Account connections hold sign-ins in Gugu's managed root. Custom models keep their own provider credentials. */

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

export async function selectHarnessConnection(
  providerId: string,
  connectionId: string,
  options: { nativeEnv?: Record<string, string | undefined> } = {}
): Promise<void> {
  supported(providerId);
  await ensureNative(providerId);
  const target = await registry.getAccount(namespace(providerId), connectionId);
  if (!target || target.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
  // 已有会话跟着默认订阅走。账号连接把凭据换进用户根;API 连接靠环境变量起,
  // 用户根里的账号原样留着(换回那个账号时它就是最新的那份)。
  if (isAccountProvider(providerId) && (target.meta?.harnessConnection?.kind ?? 'native') !== 'api-key') {
    const current = await defaultConnectionId(providerId);
    const ids = await accountConnectionIds(providerId);
    if (providerId === 'codex') await activateCodexAccount(codexSlotPaths(options.nativeEnv), ids, connectionId, current);
    else await activateClaudeAccount(claudeSlotPaths(options.nativeEnv), ids, connectionId, current);
  }
  await registry.setDefaultAccount(namespace(providerId), connectionId);
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
  if (target.meta?.credentialSource === 'vendor-key') return;
  // 其余家只有原生与 API Key 连接:原生就是这家 CLI 自己的那份,没有凭据要换。
  if (!isAccountProvider(providerId)) return;
  if (providerId === 'codex') await assertCodexFileCredentialStore(managedConfigRoot('codex'));
  if ((await credentialRoot(providerId, connectionId, options.nativeEnv)) === 'native') return;
  const saved =
    providerId === 'codex'
      ? await codexSignInSaved(codexSlotPaths(options.nativeEnv), connectionId)
      : await claudeSignInSaved(claudeSlotPaths(options.nativeEnv), connectionId);
  if (!saved) {
    throw new Error(`The selected ${providerId === 'codex' ? 'Codex' : 'Claude'} account has no saved sign-in; sign in to it again`);
  }
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
  // 只从列表里拿掉:保管目录里的登录仍归它,用户根里要是正好是它的账号,换走时还得写回去。
  await registry.upsertAccount({
    providerId: namespace(providerId),
    accountId: connectionId,
    meta: { ...target.meta, harnessConnection: { ...target.meta!.harnessConnection!, removed: true } },
  });
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

/** 用户自己的配置根:用户导出了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 就是那里,否则 `~/.claude` / `~/.codex`。 */
export function nativeConfigRoot(providerId: Provider, env: Record<string, string | undefined> = process.env): string {
  const home = requireNativeHome(providerId);
  return env[home.envVar]?.trim() || join(homedir(), home.userPath);
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

/** 能把凭据换进用户根的连接:`native` 与账号连接(含已从列表移除的 —— 它的凭据仍归它)。 */
async function accountConnectionIds(providerId: Provider): Promise<string[]> {
  return (await registry.listAccounts(namespace(providerId)))
    .filter((row) => (row.meta?.harnessConnection?.kind ?? 'native') !== 'api-key')
    .map((row) => row.accountId);
}

async function credentialRoot(
  providerId: Provider,
  connectionId: string,
  nativeEnv?: Record<string, string | undefined>
): Promise<'native' | 'vault'> {
  const ids = await accountConnectionIds(providerId);
  const selected = await defaultConnectionId(providerId);
  return providerId === 'codex'
    ? codexCredentialRoot(codexSlotPaths(nativeEnv), ids, connectionId, selected)
    : claudeCredentialRoot(claudeSlotPaths(nativeEnv), ids, connectionId, selected);
}

/** Resolved exclusively on the credential-owning machine, never in a renderer. */
export async function resolveHarnessConnection(
  providerId: string,
  input: {
    connectionId?: string;
    sessionId?: string;
    sourceSessionId?: string;
    /** 解析「用户自己的配置根」用的 env(含用户 shell 里导出的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`)。 */
    nativeEnv?: Record<string, string | undefined>;
  } = {}
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
  // 会话(不论哪条、什么时候建的)和不指名的读取跟默认连接走;只有按连接问的(登录、登录状态、用量)才指名。
  const forSession = Boolean(input.sessionId) || !input.connectionId;
  const id = forSession ? await defaultConnectionId(providerId) : input.connectionId!;
  const account = await registry.getAccount(namespace(providerId), id);
  if (!account) throw new Error('The session’s subscription connection is unavailable');
  const details = account.meta?.harnessConnection ?? { kind: 'native' as const };
  const unsetEnv = providerId === 'codex' ? [...CODEX_CONNECTION_UNSET_ENV] : [...CLAUDE_CONNECTION_UNSET_ENV];
  const unset = details.kind === 'account' ? { unsetEnv } : {};
  // Sessions use the managed root. An inactive account is read from its own vault.
  if (forSession || (await credentialRoot(providerId, id, input.nativeEnv)) === 'native') {
    return { connectionId: id, ...unset };
  }
  if (providerId === 'codex') await ensureCodexVault(vaultRoot(providerId, id));
  else await ensureClaudeVault(vaultRoot(providerId, id));
  return {
    connectionId: id,
    credentialHome: connectionHome(providerId, id),
    configRootEnv: { [requireNativeHome(providerId).envVar]: vaultRoot(providerId, id) },
    ...unset,
  };
}

/** An event must be attributed to the account the session actually ran on, never a guess. */
export async function sessionHarnessConnectionId(sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) return undefined;
  const custom = customModelRefFromOption(row.config?.model);
  if (custom) return custom.connectionId;
  // The active account in the managed root follows the selected subscription.
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
export async function migrateOwnedHarnessAccounts(providerId: Provider, env: Record<string, string | undefined>, automatic = false) {
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
    }
    let upgradeSignIn: 'copied' | 'relogin' | undefined;
    if (automatic && (owned || selected === 'native')) {
      try {
        // If B is already back in the terminal, the old in-use sign-in is the verified A now in its vault.
        const copied = await copy(result.moved?.connectionId === selected ? result.moved.identity : undefined);
        upgradeSignIn = copied === 'oauth' ? 'copied' : copied === false ? 'relogin' : undefined;
      }
      catch {
        log.warn('Could not transfer the previous sign-in during upgrade', { providerId });
        upgradeSignIn = 'relogin';
      }
    }
    const notice = await migrationNotice(providerId, result);
    return upgradeSignIn ? { ...notice, upgradeSignIn } : notice;
  };
  if (providerId === 'codex') {
    const managed = codexSlotPaths();
    const previous = { ...managed, nativeRoot: formerRoot, vaultRoot: previousVaultRoot, liveStateFile };
    return finish(() => restoreCodexTerminalForMigration(previous, ids),
      () => activateCodexAccount(managed, ids, selected, 'native'),
      (vaultIdentity) => copyCodexUpgradeSignIn(vaultIdentity ? { ...previous, nativeRoot: previous.vaultRoot(selected) } : previous,
        managed, selected, vaultIdentity));
  } else {
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
