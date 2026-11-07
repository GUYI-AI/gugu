// #7199 / #2104 助理搬家:它在这台机器上连着的「账号类」服务(邮箱、飞书、Notion、GitHub……)只交一张清单 ——
// 有哪些、怎么配的(表单里不保密的那几项)。解密后的凭据任何时候都 ❌ 进清单:新家照着清单逐个重新连接。
// 旧家那几份不撤:什么都没搬过去,撤了就两头都没有。
import type { IntegrationAuthMethod } from '@gugu/session-plugins/integrations';
import type { IntegrationMoveSummary, MoveReconnect } from '@shared/core/integrations/integration-move';

export type { IntegrationMoveSummary, MoveReconnect, MoveReconnectReason } from '@shared/core/integrations/integration-move';

export type IntegrationMoveDeps = {
  integrationIds(): string[];
  isCli(integrationId: string): boolean;
  /** 这一家表单里不保密的字段 id(服务器、端口、用户名……)。 */
  plainFields(integrationId: string): string[];
  listAccounts(integrationId: string): Promise<{
    accounts: { accountId: string; displayName?: string; isDefault: boolean; credentials: Record<string, unknown> }[];
    unreadable: string[];
  }>;
};

/** 名字像凭据的字段:插件没标 `secret` 也不进清单(Trello 的 apiKey 就没标)。 */
const CREDENTIAL_LIKE = /token|key|secret|password|passwd|authcode/i;

/** 表单里不保密的字段 id:插件声明 `secret: true` 的、名字像凭据的,一律不在里面。 */
export function plainFormFields(methods: readonly IntegrationAuthMethod[]): string[] {
  return methods.flatMap((method) =>
    method.kind === 'form'
      ? method.fields.filter((field) => !field.secret && !CREDENTIAL_LIKE.test(field.id)).map((field) => field.id)
      : []
  );
}

export async function summarizeAccountsForMove(deps: IntegrationMoveDeps): Promise<IntegrationMoveSummary> {
  const reconnect: MoveReconnect[] = [];
  for (const integrationId of deps.integrationIds()) {
    const listed = await deps.listAccounts(integrationId);
    if (deps.isCli(integrationId)) {
      // 命令行那几家记的只是「连过」,一条记录就够说明「这一家搬完要重新连」。
      if (listed.accounts.length > 0 || listed.unreadable.length > 0) reconnect.push({ integrationId, reason: 'cli' });
      continue;
    }
    const plain = deps.plainFields(integrationId);
    for (const account of listed.accounts) {
      const config = Object.fromEntries(
        plain.flatMap((id) => (typeof account.credentials[id] === 'string' ? [[id, account.credentials[id] as string]] : []))
      );
      reconnect.push({
        integrationId,
        accountId: account.accountId,
        ...(account.displayName ? { displayName: account.displayName } : {}),
        isDefault: account.isDefault,
        ...(Object.keys(config).length > 0 ? { config } : {}),
        reason: 'account',
      });
    }
    for (const accountId of listed.unreadable) reconnect.push({ integrationId, accountId, reason: 'no-secret' });
  }
  return { moving: [], reconnect };
}
