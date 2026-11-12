import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { eq } from 'drizzle-orm';
import { pluginRegistry, requireNativeHome } from '@gugu/session-plugins/agents';
import {
  ACCOUNT_PROVIDER_OFFICIAL_ENDPOINTS,
  apiKeyConnectionEndpoint,
  apiKeyConnectionInjectsModel,
  apiKeyConnectionInputError,
  type ApiKeyConnectionFields,
} from '@gugu/session-core/agents/plugins';
import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import type {
  ConnectionModelList,
  CreateHarnessConnection,
  HarnessConnection,
  ListConnectionModels,
} from '@gugu/session-core/workspace-server/agent-config';
import { providerAccountRegistry as registry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import {
  activateClaudeAccount,
  claudeCredentialRoot,
  claudeSignInSaved,
  ensureClaudeVault,
  type ClaudeAuthSlotPaths,
} from './claude-auth-slot';
import { createClaudeCredentialStore, type ClaudeCredentialStore } from './claude-credential-store';
import { moveClaudeHistoryToUserRoot } from './claude-history-move';
import {
  activateCodexAccount,
  assertCodexFileCredentialStore,
  codexCredentialRoot,
  codexSignInSaved,
  ensureCodexVault,
  type CodexAuthSlotPaths,
} from './codex-auth-slot';
import {
  CLAUDE_CONNECTION_UNSET_ENV,
  CODEX_CONNECTION_UNSET_ENV,
  claudeApiKeyEnv,
  codexApiKeyConnectionArgs,
} from './harness-connection-launch';
import { detectEndpointProtocol, listEndpointModels } from './connection-endpoint-probe';

/**
 * 订阅连接(#26,照 cockpit-tools):两家的会话都跑在用户自己的配置根上(`~/.claude` / `~/.codex`,
 * 或用户导出的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`),所有会话跟着默认连接走,❌ 钉在创建时的连接上。
 * 账号连接 = 一个保管目录,存这个账号的登录、能独立登录和读用量;选中它 = 把它的凭据换进用户根。
 * API 连接只在启动时给环境变量,用户根里的账号原样留着。
 */

type Provider = 'claude' | 'codex';

const namespace = (providerId: string) => `harness:${providerId}`;

/** Claude / Codex:账号连接 + API 连接,换凭据的代码逐家写(下面那一整套)。 */
function isAccountProvider(providerId: string): providerId is Provider {
  return providerId === 'claude' || providerId === 'codex';
}

/**
 * 其余家(#2507):声明了 `apiKeyConnection` 的才有连接,而且只有 API Key 连接 —— 账号仍是这家 CLI 自己的登录。
 * 判据只认插件注册表,renderer 送来的 id 不作数。
 */
function apiKeyConnectionOf(providerId: string) {
  if (isAccountProvider(providerId)) return undefined;
  const plugin = pluginRegistry.get(providerId);
  const descriptor = plugin?.capabilities.apiKeyConnection;
  if (descriptor?.kind !== 'supported') return undefined;
  // 走模型注入的家:写法是它的平台模型写法(注册时核过平台 supported),没有自己的 `launch`。
  if (apiKeyConnectionInjectsModel(descriptor)) {
    return { name: plugin!.metadata.name, fields: descriptor, injectsModel: true as const };
  }
  const behavior = plugin?.behavior.apiKeyConnection;
  if (!behavior) return undefined;
  return { name: plugin!.metadata.name, fields: descriptor, injectsModel: false as const, launch: behavior.launch };
}

/** 这一家能不能有连接 —— 只有主进程这一处判。 */
export function harnessHasConnections(providerId: string): boolean {
  return isAccountProvider(providerId) || apiKeyConnectionOf(providerId) !== undefined;
}

function supported(providerId: string): void {
  if (!harnessHasConnections(providerId)) throw new Error('Connection management is unavailable for this harness');
}

type ConnectionFields = Pick<ApiKeyConnectionFields, 'endpoint' | 'model' | 'officialEndpoint' | 'protocol' | 'protocols'>;

/**
 * 这一家 API Key 连接的格子。Claude / Codex:地址可选(预填官方地址)、没有模型格;其余家照它的声明。
 */
function connectionFields(providerId: string): ConnectionFields {
  const generic = apiKeyConnectionOf(providerId);
  if (generic) return generic.fields;
  return {
    endpoint: 'optional',
    model: 'none',
    officialEndpoint: ACCOUNT_PROVIDER_OFFICIAL_ENDPOINTS[providerId],
    protocol: providerId === 'claude' ? 'anthropic-messages' : 'openai-responses',
  };
}

type StoredConnection = NonNullable<NonNullable<Awaited<ReturnType<typeof registry.getAccount>>>['meta']>['harnessConnection'];

/** 连接点名的模型:修改前只存了一个(`model`),读的时候并进来。 */
function storedModels(details: StoredConnection): string[] {
  if (details?.models?.length) return [...details.models];
  return details?.model ? [details.model] : [];
}

/**
 * 进程要用的地址:记下的(用户改过的)那一个;没记 = 官方 —— 离了地址起不来的家递官方地址,
 * 地址可选的家(Claude / Codex / dsh)什么都不递,它们自己就是官方。
 */
function launchEndpoint(fields: ConnectionFields, stored: string | undefined): string | undefined {
  return apiKeyConnectionEndpoint(fields, stored) ?? (fields.endpoint === 'required' ? fields.officialEndpoint : undefined);
}

/** 读模型清单 / 探接口要打的地址:用户填的,没填就是官方的。 */
function probeEndpoint(fields: ConnectionFields, typed: string | undefined): string | undefined {
  return apiKeyConnectionEndpoint(fields, typed) ?? fields.officialEndpoint;
}

function connectionView(row: { accountId: string; isDefault: boolean; meta?: { displayName?: string; harnessConnection?: StoredConnection } | null }, fields: ConnectionFields): HarnessConnection {
  const details = row.meta?.harnessConnection;
  const endpoint = apiKeyConnectionEndpoint(fields, details?.endpoint);
  const models = storedModels(details);
  return {
    id: row.accountId,
    kind: details?.kind ?? 'native',
    name: row.meta?.displayName ?? '',
    ...(endpoint ? { endpoint } : {}),
    ...(models.length ? { models } : {}),
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
  await ensureNative(providerId);
  const fields = connectionFields(providerId);
  return (await registry.listAccounts(namespace(providerId)))
    .filter((row) => !row.meta?.harnessConnection?.removed)
    .map((row) => connectionView(row, fields));
}

export async function createHarnessConnection(input: CreateHarnessConnection): Promise<HarnessConnection> {
  supported(input.providerId);
  const generic = apiKeyConnectionOf(input.providerId);
  // 账号连接只有 Claude / Codex;其余家的账号就是它 CLI 自己的那份登录(「现有 CLI 配置」上的「登录」)。
  if (generic && input.kind !== 'api-key') throw new Error('This harness signs in through its own CLI; add an API key connection instead');
  const fields = connectionFields(input.providerId);
  const typed = input.endpoint?.trim().replace(/\/+$/, '') || undefined;
  if (input.kind === 'api-key') {
    // 地址格预填的是官方地址:没改 = 官方,离了地址起不来的家也算填了。
    const problem = apiKeyConnectionInputError(fields, { endpoint: typed ?? (fields.endpoint === 'required' ? fields.officialEndpoint : undefined), models: input.models });
    if (problem) throw new Error(problem);
  }
  await ensureNative(input.providerId);
  const id = randomUUID();
  // 官方地址不记:处处照「没有地址」读作官方(付款方、连接那一行、用量)。
  const endpoint = apiKeyConnectionEndpoint(fields, typed);
  const models = input.kind === 'api-key' && input.models?.length ? [...input.models] : undefined;
  // 讲得了好几种接口的家(pi / opencode):这一刻按地址探一次,记下来,会话照它写配置。
  const detected =
    input.kind === 'api-key' && input.apiKey && fields.protocols && fields.protocols.length > 1 && fields.protocol
      ? await detectEndpointProtocol({
          endpoint: probeEndpoint(fields, typed)!,
          apiKey: input.apiKey,
          candidates: fields.protocols,
          fallback: fields.protocol,
        })
      : undefined;
  const protocol = detected === 'openai-responses' || detected === 'openai-chat-completions' ? detected : undefined;
  const rows = await listHarnessConnections(input.providerId);
  const name =
    input.name ||
    (endpoint
      ? new URL(endpoint).host
      : `${generic ? generic.name : input.providerId === 'claude' ? 'Claude' : 'Codex'} ${rows.length}`);
  // 账号连接只需要一个保管凭据、能独立登录的目录;API 连接什么目录都不要。
  if (input.kind === 'account') {
    if (input.providerId === 'codex') await ensureCodexVault(vaultRoot('codex', id));
    else await ensureClaudeVault(vaultRoot('claude', id));
  }
  await registry.upsertAccount({
    providerId: namespace(input.providerId),
    accountId: id,
    ...(input.apiKey ? { secret: input.apiKey } : {}),
    meta: {
      displayName: name,
      harnessConnection: {
        kind: input.kind,
        ...(endpoint ? { endpoint } : {}),
        ...(models ? { models } : {}),
        ...(protocol ? { protocol } : {}),
      },
    },
  });
  return { id, name, kind: input.kind, ...(endpoint ? { endpoint } : {}), ...(models ? { models } : {}), current: false };
}

/** 「管理模型」(#2507):换一把已存 API Key 连接点名的模型,❌ 删了重加。 */
export async function updateHarnessConnectionModels(providerId: string, connectionId: string, models: readonly string[]): Promise<HarnessConnection> {
  supported(providerId);
  const fields = connectionFields(providerId);
  if (fields.model !== 'required') throw new Error('This agent takes no model with its API key');
  const target = await registry.getAccount(namespace(providerId), connectionId);
  const details = target?.meta?.harnessConnection;
  if (!target || !details || details.removed) throw new Error('Connection no longer exists');
  if (details.kind !== 'api-key') throw new Error('Only an API key connection names its models');
  const problem = apiKeyConnectionInputError({ endpoint: 'none', model: 'required' }, { models });
  if (problem) throw new Error(problem);
  const { model: _legacy, ...rest } = details;
  await registry.upsertAccount({
    providerId: namespace(providerId),
    accountId: connectionId,
    meta: { ...target.meta, harnessConnection: { ...rest, models: [...new Set(models)] } },
  });
  const updated = await registry.getAccount(namespace(providerId), connectionId);
  return connectionView({ accountId: connectionId, isDefault: updated?.isDefault ?? target.isDefault, meta: updated?.meta ?? null }, fields);
}

/**
 * 读一个地址报的模型清单(#2507):表单里还没存的连接用它带来的 key 与地址;已存的连接用它自己的。
 * 只在宿主里读,key 只发给那个地址本身。
 */
export async function readConnectionModels(input: ListConnectionModels): Promise<ConnectionModelList> {
  supported(input.providerId);
  const fields = connectionFields(input.providerId);
  if (fields.model !== 'required') throw new Error('This agent takes no model with its API key');
  let endpoint: string | undefined;
  let apiKey: string | undefined;
  if (input.connectionId) {
    const account = await registry.getAccount(namespace(input.providerId), input.connectionId);
    const details = account?.meta?.harnessConnection;
    if (!account || details?.kind !== 'api-key' || details.removed) throw new Error('Connection no longer exists');
    endpoint = probeEndpoint(fields, details.endpoint);
    apiKey = (await registry.resolveSecret(namespace(input.providerId), input.connectionId)) ?? undefined;
    if (!apiKey) throw new Error('The connection’s API key is unavailable');
  } else {
    endpoint = probeEndpoint(fields, input.endpoint);
    apiKey = input.apiKey;
  }
  if (!endpoint || !apiKey) return { kind: 'unlisted', reason: 'unreachable' };
  return listEndpointModels({ endpoint, apiKey, protocol: fields.protocol });
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
  if ((target.meta?.harnessConnection?.kind ?? 'native') === 'api-key') return;
  // 其余家只有原生与 API Key 连接:原生就是这家 CLI 自己的那份,没有凭据要换。
  if (!isAccountProvider(providerId)) return;
  if (providerId === 'codex') await assertCodexFileCredentialStore(nativeConfigRoot('codex', options.nativeEnv));
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
  return isAccountProvider(providerId) || !apiKeyConnectionOf(providerId) ? connectionId : 'native';
}

function connectionHome(providerId: Provider, id: string): string {
  return join(app.getPath('userData'), 'harness-connections', providerId, id);
}

/** 连接的保管目录:布局与用户根相同(`<连接 home>/.claude` / `.codex`),登录与用量读取以它为配置根。 */
function vaultRoot(providerId: Provider, id: string): string {
  return join(connectionHome(providerId, id), requireNativeHome(providerId).userPath);
}

/**
 * 单一目录之前,Claude 账号 / API 连接上的会话跑在连接自己的配置根里,记录也在那里(就是今天的保管目录)。
 * 开机时已搬进用户根;这里留给读记录的一侧做兜底(搬失败的、或还没开过机的)。原生连接与 Codex ⇒ null。
 */
export function connectionConfigRoot(providerId: string, connectionId: string): string | null {
  if (providerId !== 'claude' || connectionId === 'native') return null;
  return vaultRoot('claude', connectionId);
}

/** 用户自己的配置根:用户导出了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 就是那里,否则 `~/.claude` / `~/.codex`。 */
function nativeConfigRoot(providerId: Provider, env: Record<string, string | undefined> = process.env): string {
  const home = requireNativeHome(providerId);
  return env[home.envVar]?.trim() || join(homedir(), home.userPath);
}

function codexSlotPaths(env?: Record<string, string | undefined>): CodexAuthSlotPaths {
  return {
    nativeRoot: nativeConfigRoot('codex', env),
    vaultRoot: (id) => vaultRoot('codex', id),
    backupDir: join(app.getPath('userData'), 'harness-connections', 'codex', 'unrecognized-sign-ins'),
    liveStateFile: join(app.getPath('userData'), 'harness-connections', 'codex', 'live-account.json'),
  };
}

let claudeStore: ClaudeCredentialStore | null = null;

function claudeSlotPaths(env: Record<string, string | undefined> = process.env): ClaudeAuthSlotPaths {
  // 用户导出了 `CLAUDE_CONFIG_DIR`:`.claude.json` 在那个根里,钥匙串条目名带这个根的哈希;否则在 home 下、不带。
  const exported = Boolean(env.CLAUDE_CONFIG_DIR?.trim());
  const nativeRoot = nativeConfigRoot('claude', env);
  claudeStore ??= createClaudeCredentialStore();
  return {
    nativeRoot,
    nativeGlobalConfig: exported ? join(nativeRoot, '.claude.json') : join(homedir(), '.claude.json'),
    nativeSuffixed: exported,
    vaultRoot: (id) => vaultRoot('claude', id),
    backupDir: join(app.getPath('userData'), 'harness-connections', 'claude', 'unrecognized-sign-ins'),
    liveStateFile: join(app.getPath('userData'), 'harness-connections', 'claude', 'live-account.json'),
    store: claudeStore,
  };
}

async function defaultConnectionId(providerId: Provider): Promise<string> {
  return (await registry.getDefaultAccountId(namespace(providerId))) ?? 'native';
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
  if (!isAccountProvider(providerId)) return resolveApiKeyConnection(providerId, input);
  await ensureNative(providerId);
  // 会话(不论哪条、什么时候建的)和不指名的读取跟默认连接走;只有按连接问的(登录、登录状态、用量)才指名。
  const forSession = Boolean(input.sessionId) || !input.connectionId;
  const id = forSession ? await defaultConnectionId(providerId) : input.connectionId!;
  const account = await registry.getAccount(namespace(providerId), id);
  if (!account) throw new Error('The session’s subscription connection is unavailable');
  const details = account.meta?.harnessConnection ?? { kind: 'native' as const };
  const unsetEnv = providerId === 'codex' ? [...CODEX_CONNECTION_UNSET_ENV] : [...CLAUDE_CONNECTION_UNSET_ENV];
  if (details.kind === 'api-key') {
    const secret = await registry.resolveSecret(namespace(providerId), id);
    if (!secret) throw new Error('The connection’s API key is unavailable');
    // 修改前存进去的官方地址照「官方」跑(与没写地址逐字节一样)。
    const endpoint = apiKeyConnectionEndpoint(connectionFields(providerId), details.endpoint);
    return providerId === 'codex'
      ? { connectionId: id, credentialEnv: { OPENAI_API_KEY: secret }, unsetEnv, extraArgs: codexApiKeyConnectionArgs(id, endpoint) }
      : { connectionId: id, credentialEnv: claudeApiKeyEnv(secret, endpoint), unsetEnv };
  }
  const unset = details.kind === 'account' ? { unsetEnv } : {};
  // 会话、模型目录探针、主读数:恒在用户根上跑。按连接问的,这个账号此刻不在用户根里时,保管目录那份才是它最新的凭据。
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

/**
 * 其余家(#2507):选中的是 API Key 连接 ⇒ 按这家的声明把 key 落成环境变量 / 参数,删掉同族的继承变量,
 * 并标上「这是一把 API Key 连接」(登录态与付费方照它答)。原生连接一个字都不加 —— 与没有连接的时候逐字节一样。
 */
async function resolveApiKeyConnection(
  providerId: string,
  input: { connectionId?: string; sessionId?: string }
): Promise<Partial<AgentRunContext>> {
  const generic = apiKeyConnectionOf(providerId);
  if (!generic) return {};
  await ensureNative(providerId);
  const forSession = Boolean(input.sessionId) || !input.connectionId;
  const id = forSession ? (await registry.getDefaultAccountId(namespace(providerId))) ?? 'native' : input.connectionId!;
  if (id === 'native') return {};
  const account = await registry.getAccount(namespace(providerId), id);
  if (!account) throw new Error('The session’s subscription connection is unavailable');
  const details = account.meta?.harnessConnection;
  if (details?.kind !== 'api-key') return {};
  const fields = connectionFields(providerId);
  // 官方地址(没改预填的那个,或修改前存进去的)不进标记:付款方与用量照「官方」答。
  const custom = apiKeyConnectionEndpoint(fields, details.endpoint);
  const marker = custom ? { endpoint: custom } : {};
  // 走模型注入的家:key 不进这份环境 —— 它随宿主造的模型声明进这家自己的配置(见 `resolveConnectionModel`)。
  // 这里只标「选中的是一把 API Key」,登录态与付费方照它答。
  if (generic.injectsModel) return { connectionId: id, apiKeyConnection: marker };
  const secret = await registry.resolveSecret(namespace(providerId), id);
  if (!secret) throw new Error('The connection’s API key is unavailable');
  const endpoint = launchEndpoint(fields, details.endpoint);
  const model = await sessionModelAmong(input.sessionId, storedModels(details));
  const launch = generic.launch({
    apiKey: secret,
    ...(endpoint ? { endpoint } : {}),
    ...(model ? { model } : {}),
  });
  return {
    connectionId: id,
    credentialEnv: { ...launch.env },
    unsetEnv: [...launch.unsetEnv],
    ...(launch.args?.length ? { extraArgs: [...launch.args] } : {}),
    // 点名的模型随标记走:会话按它启动,运行时据此不再拿记录里的模型名去设(见 session-manager `recordedModelTarget`)。
    apiKeyConnection: model ? { ...marker, model } : marker,
  };
}

/**
 * 会话跑连接点名的哪一个模型:会话自己选的(新建任务的模型菜单)在其中就是它,否则第一个。
 * 没有会话(探针、登录态)⇒ 第一个。
 */
async function sessionModelAmong(sessionId: string | undefined, models: readonly string[]): Promise<string | undefined> {
  if (models.length === 0) return undefined;
  if (sessionId) {
    const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    const chosen = row?.config?.model?.trim();
    if (chosen && models.includes(chosen)) return chosen;
  }
  return models[0];
}

/**
 * 新建任务的模型菜单(#2507,spec「一家使用中的是 API Key 连接时,新任务里这一家的模型菜单列出这把连接勾选的全部模型,
 * 默认选中第一个」):key 走环境变量、又要点名模型的家(Qwen、Copilot、ZCode、Hermes、Antigravity),使用中的是一把
 * API Key 连接 ⇒ 它勾选的模型。走模型注入的家另有一条(`resolveConnectionModel`:这家自己的目录照连接读)。别的情况 null。
 * 只读:不建「原生」那一行。
 */
export async function currentConnectionMenuModels(providerId: string): Promise<string[] | null> {
  const generic = apiKeyConnectionOf(providerId);
  if (!generic || generic.injectsModel || generic.fields.model !== 'required') return null;
  const id = await registry.getDefaultAccountId(namespace(providerId));
  if (!id || id === 'native') return null;
  const details = (await registry.getAccount(namespace(providerId), id))?.meta?.harnessConnection;
  if (details?.kind !== 'api-key' || details.removed) return null;
  const models = storedModels(details);
  return models.length > 0 ? models : null;
}

/**
 * 一把要经模型注入进进程的 API Key 连接:解密后的 key 与它的地址、点名的模型、探出来的接口。只在主进程、起会话那一刻有。
 * `name` = 连接的名字(用户的备注,没写就是建连接时生成的那个):这一家自己的界面里,提供方就叫它。
 * `models` 全部写进这一家的模型声明(新建任务的模型菜单里都在、会话里能切),第一个是起步模型。
 */
export type ConnectionModel = {
  connectionId: string;
  name: string;
  endpoint: string;
  apiKey: string;
  models: string[];
  protocol?: 'openai-responses' | 'openai-chat-completions';
};

/**
 * 声明了 `delivery: 'model-injection'` 的家(#2507):会话此刻该跑的那把 API Key —— 默认连接是它就给,
 * 原生连接 / 没声明的家给 null(宿主照旧,与没有连接时逐字节一样)。会话跟着默认连接走,与上面同一条。
 */
export async function resolveConnectionModel(providerId: string, sessionId?: string): Promise<ConnectionModel | null> {
  const generic = apiKeyConnectionOf(providerId);
  if (!generic?.injectsModel) return null;
  await ensureNative(providerId);
  const id = (await registry.getDefaultAccountId(namespace(providerId))) ?? 'native';
  if (id === 'native') return null;
  const account = await registry.getAccount(namespace(providerId), id);
  if (!account) throw new Error('The session’s subscription connection is unavailable');
  const details = account.meta?.harnessConnection;
  if (details?.kind !== 'api-key') return null;
  const endpoint = launchEndpoint(generic.fields, details.endpoint);
  const named = storedModels(details);
  if (!endpoint || named.length === 0) throw new Error('The connection has no API address or model');
  // 会话自己选的那个排第一(起步模型),其余照旧。
  const first = await sessionModelAmong(sessionId, named);
  const models = [first!, ...named.filter((model) => model !== first)];
  const secret = await registry.resolveSecret(namespace(providerId), id);
  if (!secret) throw new Error('The connection’s API key is unavailable');
  // 名字在建连接时就落定了(`createHarnessConnection`);缺了(手改过的库)就叫这一家的名字,❌ 落回平台的叫法。
  const name = account.meta?.displayName?.trim() || generic.name;
  return { connectionId: id, name, endpoint, apiKey: secret, models, ...(details.protocol ? { protocol: details.protocol } : {}) };
}

/**
 * 升级对齐(#26):修复前账号连接的凭据只在它自己的目录里,默认订阅是它、用户根里却是另一个账号。
 * 只在还没有会话跑起来的时候调(开机)。默认是原生 / API 连接时不动:用户根里的就是用户在 CLI 里登录的那个。
 */
async function alignDefaultAccount(providerId: Provider, nativeEnv?: Record<string, string | undefined>): Promise<void> {
  await ensureNative(providerId);
  const id = await defaultConnectionId(providerId);
  if (id === 'native') return;
  const account = await registry.getAccount(namespace(providerId), id);
  if (account?.meta?.harnessConnection?.kind !== 'account') return;
  if ((await credentialRoot(providerId, id, nativeEnv)) === 'native') return;
  const ids = await accountConnectionIds(providerId);
  if (providerId === 'codex') await activateCodexAccount(codexSlotPaths(nativeEnv), ids, id, id);
  else await activateClaudeAccount(claudeSlotPaths(nativeEnv), ids, id, id);
}

export async function alignCodexDefaultAccount(nativeEnv?: Record<string, string | undefined>): Promise<void> {
  await alignDefaultAccount('codex', nativeEnv);
}

/** Claude 还要先把连接根里的会话记录搬进用户根(见 `claude-history-move.ts`),一个连接搬不动不拦别的。 */
export async function alignClaudeConnections(nativeEnv?: Record<string, string | undefined>): Promise<void> {
  await ensureNative('claude');
  const nativeRoot = nativeConfigRoot('claude', nativeEnv);
  for (const row of await registry.listAccounts(namespace('claude'))) {
    if (row.accountId === 'native') continue;
    try {
      if (await moveClaudeHistoryToUserRoot(vaultRoot('claude', row.accountId), nativeRoot)) {
        log.info('harness connections: moved Claude session history into the user root', { connectionId: row.accountId });
      }
    } catch (error) {
      log.warn('harness connections: could not move Claude session history; it stays readable from the connection root', {
        connectionId: row.accountId,
        error: String(error),
      });
    }
  }
  await alignDefaultAccount('claude', nativeEnv);
}

/** 开机时、任何会话起来之前调一次(embedded-boot)。一家对不齐不拦另一家。 */
export async function alignHarnessConnectionsAtStartup(): Promise<void> {
  const { resolveLocalAgentSpawnEnv } = await import('./agent-run-context');
  const failures: unknown[] = [];
  for (const [providerId, align] of [['codex', alignCodexDefaultAccount], ['claude', alignClaudeConnections]] as const) {
    try {
      await align(await resolveLocalAgentSpawnEnv(providerId));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'harness connections: startup alignment failed');
}

/** An event must be attributed to the account the session actually ran on, never a guess. */
export async function sessionHarnessConnectionId(sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) return undefined;
  // 两家的会话都跟默认订阅走:跑的就是此刻用户根里的账号 = 当前默认连接(#26)。
  if (row.provider === 'codex' || row.provider === 'claude') return defaultConnectionId(row.provider);
  // 有 API Key 连接的家(#2507)同一条:跑的是起进程那一刻的默认连接。
  const provider = row.provider;
  if (provider && apiKeyConnectionOf(provider)) {
    return (await registry.getDefaultAccountId(namespace(provider))) ?? 'native';
  }
  return 'native';
}
