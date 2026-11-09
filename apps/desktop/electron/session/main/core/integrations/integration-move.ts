// #7199 助理搬家:它在这台机器上连着的「账号类」服务(邮箱、飞书、Notion、GitHub……)的授权,复制一份到新家。
// 只管凭据本身 —— 官方命令行那两家(钉钉 / 企业微信)的登录态在那台机器的命令行目录里,带不走,搬完要在新家重新连;
// 靠 gh 命令行登录、本机没存密钥的 GitHub 账号同理。这些都**不静默丢**:导出时逐条说清「没带」和原因。
// 导入是照原样写进新家的账号表,❌ 联网校验(搬运不该因为对方服务一时连不上就丢账号);连得上连不上,新家的资源库页自己会查。
// 一条存不进去只影响这一条:逐条报回去让人手动重连,旧家那份从不动,任何一步失败都不会两边都没有。
import type { IntegrationAuthMethod, IntegrationCredentials } from '@gugu/session-plugins/integrations';
import { SecureStorageUnavailableError } from '@main/core/secrets/secure-storage-unavailable';
import type {
  IntegrationMoveExport,
  IntegrationMoveImport,
  MovableIntegrationAccount,
  MoveSkipped,
} from '@shared/core/integrations/integration-move';

export type {
  IntegrationMoveExport,
  IntegrationMoveImport,
  MovableIntegrationAccount,
  MoveSkipReason,
  MoveSkipped,
} from '@shared/core/integrations/integration-move';

export type IntegrationMoveDeps = {
  integrationIds(): string[];
  isCli(integrationId: string): boolean;
  hasIntegration(integrationId: string): boolean;
  /** 这一家表单里不保密的字段 id(服务器、端口、用户名……)。 */
  plainFields(integrationId: string): string[];
  listAccounts(integrationId: string): Promise<{
    accounts: { accountId: string; displayName?: string; isDefault: boolean; credentials: IntegrationCredentials }[];
    unreadable: string[];
  }>;
  upsertAccount(
    integrationId: string,
    account: { accountId: string; displayName?: string; credentials: IntegrationCredentials }
  ): Promise<void>;
  setDefault(integrationId: string, accountId: string): Promise<boolean>;
  deleteAccount(integrationId: string, accountId: string): Promise<void>;
  /** 只收 id 和错误类型名:底层错误文案可能夹带写入的参数,❌ 进日志。 */
  warn(message: string, context: { integrationId: string; accountId: string; errorName: string }): void;
};

/** 名字像凭据的字段:插件没标 `secret` 也不算不保密(Trello 的 apiKey 就没标)。 */
const CREDENTIAL_LIKE = /token|key|secret|password|passwd|authcode/i;

/** 表单里不保密的字段 id:插件声明 `secret: true` 的、名字像凭据的,一律不在里面。 */
export function plainFormFields(methods: readonly IntegrationAuthMethod[]): string[] {
  return methods.flatMap((method) =>
    method.kind === 'form'
      ? method.fields.filter((field) => !field.secret && !CREDENTIAL_LIKE.test(field.id)).map((field) => field.id)
      : []
  );
}

/** 地址里夹带的账号密码(`https://user:pass@host`):去掉再当配置,留下的地址照样能认出是哪台。 */
function withoutUserinfo(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');
}

function plainConfig(credentials: IntegrationCredentials, fields: string[]): Record<string, string> | undefined {
  const values = credentials as Record<string, unknown>;
  const config = Object.fromEntries(
    fields.flatMap((id) => (typeof values[id] === 'string' ? [[id, withoutUserinfo(values[id] as string)]] : []))
  );
  return Object.keys(config).length > 0 ? config : undefined;
}

export async function exportAccountsForMove(deps: IntegrationMoveDeps): Promise<IntegrationMoveExport> {
  const accounts: MovableIntegrationAccount[] = [];
  const skipped: MoveSkipped[] = [];
  for (const integrationId of deps.integrationIds()) {
    const listed = await deps.listAccounts(integrationId);
    if (deps.isCli(integrationId)) {
      // 命令行那几家记的只是「连过」,一条记录就够说明「这一家搬完要重新连」。
      if (listed.accounts.length > 0 || listed.unreadable.length > 0) skipped.push({ integrationId, reason: 'cli' });
      continue;
    }
    const plain = deps.plainFields(integrationId);
    for (const account of listed.accounts) {
      const config = plainConfig(account.credentials, plain);
      accounts.push({
        integrationId,
        accountId: account.accountId,
        ...(account.displayName ? { displayName: account.displayName } : {}),
        isDefault: account.isDefault,
        credentials: account.credentials,
        ...(config ? { config } : {}),
      });
    }
    for (const accountId of listed.unreadable) skipped.push({ integrationId, accountId, reason: 'no-secret' });
  }
  return { accounts, skipped };
}

/** 凭据是否同一份(键序无关);搬运的幂等 / 冲突判断用。 */
function sameCredentials(a: IntegrationCredentials, b: IntegrationCredentials): boolean {
  const canon = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canon).join(',')}]`
      : value && typeof value === 'object'
        ? `{${Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canon((value as Record<string, unknown>)[key])}`)
            .join(',')}}`
        : JSON.stringify(value);
  return canon(a) === canon(b);
}

export async function importAccountsFromMove(
  deps: IntegrationMoveDeps,
  incoming: readonly MovableIntegrationAccount[]
): Promise<IntegrationMoveImport> {
  const skipped: MoveSkipped[] = [];
  let imported = 0;
  const defaults = new Map<string, string>();
  const skip = (account: MovableIntegrationAccount, reason: MoveSkipped['reason']) =>
    skipped.push({
      integrationId: account.integrationId,
      accountId: account.accountId,
      ...(account.displayName ? { displayName: account.displayName } : {}),
      ...(account.config ? { config: account.config } : {}),
      reason,
    });
  const warnNotDone = (message: string, integrationId: string, accountId: string, cause: unknown) =>
    deps.warn(message, { integrationId, accountId, errorName: cause instanceof Error ? cause.name : typeof cause });
  for (const account of incoming) {
    if (!deps.hasIntegration(account.integrationId)) {
      skip(account, 'unknown-integration');
      continue;
    }
    if (deps.isCli(account.integrationId)) {
      skip(account, 'cli');
      continue;
    }
    // 这一条是这次才写进来的:读回不对就得收回去,否则留下一个坏的「已连接」账号,以后再搬一直判 exists。
    let createdHere = false;
    try {
      // 新家已经连着同一个 id 的另一份凭据(人在两头各自连过同一家):不覆盖 —— 覆盖就把新家原来那个账号弄没了。
      // 同一份凭据 = 上一次搬到一半留下的,当作已经搬过(幂等)。
      const before = await deps.listAccounts(account.integrationId);
      const present = before.accounts.find((a) => a.accountId === account.accountId)?.credentials;
      if (present && !sameCredentials(present, account.credentials)) {
        skip(account, 'exists');
        continue;
      }
      await deps.upsertAccount(account.integrationId, {
        accountId: account.accountId,
        ...(account.displayName ? { displayName: account.displayName } : {}),
        credentials: account.credentials,
      });
      createdHere = !present && !before.unreadable.includes(account.accountId);
      // 写完读回来对一遍:读不回来就不算带过去了。
      const stored = (await deps.listAccounts(account.integrationId)).accounts.find((a) => a.accountId === account.accountId)?.credentials;
      if (!stored || !sameCredentials(stored, account.credentials)) throw new Error('credential read-back mismatch');
      imported += 1;
      if (account.isDefault) defaults.set(account.integrationId, account.accountId);
    } catch (cause) {
      warnNotDone('Integration account not imported', account.integrationId, account.accountId, cause);
      if (createdHere) {
        await deps.deleteAccount(account.integrationId, account.accountId).catch((failure: unknown) =>
          warnNotDone('Integration account not cleaned up', account.integrationId, account.accountId, failure)
        );
      }
      skip(account, cause instanceof SecureStorageUnavailableError ? 'no-keyring' : 'import-failed');
    }
  }
  // 「谁是默认」放到最后一并落:账号表对「第一个写进去的当默认」,搬过来的次序不该决定它。账号已经在了,这一步没成不算没搬。
  for (const [integrationId, accountId] of defaults) {
    await deps.setDefault(integrationId, accountId).catch((cause: unknown) =>
      warnNotDone('Integration default account not set', integrationId, accountId, cause)
    );
  }
  return { imported, skipped };
}

/**
 * 确认框要列「这次会带走哪些账号」:只要名字,不含任何密钥 —— 凭据不离开主进程(真正搬的时候才经设备通道走)。
 * `reconnect` = 带不走、搬完要在新家重新连的(命令行那几家、本机没存密钥的账号)。
 */
export async function previewAccountsForMove(deps: IntegrationMoveDeps): Promise<{
  moving: { integrationId: string; accountId: string; displayName?: string }[];
  reconnect: MoveSkipped[];
}> {
  const exported = await exportAccountsForMove(deps);
  return {
    moving: exported.accounts.map(({ integrationId, accountId, displayName }) => ({
      integrationId,
      accountId,
      ...(displayName ? { displayName } : {}),
    })),
    reconnect: exported.skipped,
  };
}
