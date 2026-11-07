import { integrationPluginRegistry, type IntegrationCredentials } from '@gugu/session-plugins/integrations';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { cliMethodOf } from './cli/cli-integrations';
import { checkAllIntegrationConnections, checkConfiguredIntegrations } from './connection-statuses';
import { integrationConnectionService } from './integration-connection-service';
import { integrationCredentialStore } from './integration-credential-store-instance';
import { plainFormFields, summarizeAccountsForMove, type IntegrationMoveDeps } from './integration-move';
import { buildIntegrationListPayload } from './integration-payload-builder';
import { platformCredentials } from './platform-credentials-instance';
import { integrationReachesAgent } from './session-integrations';

const moveDeps: IntegrationMoveDeps = {
  // #921 平台保管的那几家不随助理搬:平台是按人存的,新家本来就连着。存在这台电脑上的(没有平台服务的安装)照旧搬。
  integrationIds: () =>
    integrationPluginRegistry
      .getAll()
      .map((plugin) => plugin.metadata.id)
      .filter((integrationId) => platformCredentials.custody(integrationId) !== 'platform'),
  isCli: (integrationId) => cliMethodOf(integrationId) !== null,
  plainFields: (integrationId) => plainFormFields(integrationPluginRegistry.get(integrationId)?.capabilities.auth.methods ?? []),
  listAccounts: (integrationId) => integrationCredentialStore.listAccountsDetailed(integrationId),
};

export const integrationsController = createRPCController({
  /** `locale` = 请求方的界面语言(插件的中英两份在这里解析成字符串);老桌面不传 ⇒ en。 */
  list: async (locale?: string) => {
    // #921 连接页要说凭据在哪保管:还不知道这个安装有没有平台服务就先问一次。
    await platformCredentials.knowCustody();
    return buildIntegrationListPayload(locale, (integrationId) => platformCredentials.custody(integrationId), integrationReachesAgent);
  },

  /** 资源库那一页:注册表里每一家连没连上(检查一次)/ 存没存着凭据(不联网)。 */
  checkAllConnections: async () => checkAllIntegrationConnections(),

  checkConfiguredConnections: async () => checkConfiguredIntegrations(),

  /** `editAccountId`(#7240「编辑凭据」):改的是哪个已存账号,留空的授权码沿用存着的。老桌面不传。 */
  connect: async (integrationId: string, credentials: IntegrationCredentials, editAccountId?: string) =>
    integrationConnectionService.connect(integrationId, credentials, editAccountId),

  /** `accountId`(#7240):多账号里只断开这一个;不传 = 整家断开(老桌面)。 */
  disconnect: async (integrationId: string, accountId?: string) =>
    integrationConnectionService.disconnect(integrationId, accountId),

  /** #7240 这一家存着的每个账号(不含任何保密项)。 */
  accounts: async (integrationId: string) => integrationConnectionService.listAccounts(integrationId),

  /** #7240 每个账号各查一次还连不连得上。 */
  checkAccounts: async (integrationId: string) => integrationConnectionService.checkAccounts(integrationId),

  authorize: async (integrationId: string) => integrationConnectionService.authorize(integrationId),
  /** A phone opens the broker's URL itself; the headless host never opens a browser. */
  platformOAuthStart: async (integrationId: string) => platformCredentials.beginOAuth(integrationId),
  platformOAuthStatus: async (integrationId: string, attemptId: string) => platformCredentials.oauthStatus(integrationId, attemptId),
  platformOAuthCancel: async (integrationId: string, attemptId: string) => platformCredentials.cancelOAuth(integrationId, attemptId),

  /**
   * #6264 连别的机器上的集成:浏览器授权在这台桌面上做(回调只能落在本机的 127.0.0.1),
   * 凭据不在这里存,交回去给那台机器的 `connect`。
   */
  acquireAuthorization: async (integrationId: string) =>
    integrationConnectionService.acquireAuthorization(integrationId),

  cancelAuthorization: async (integrationId: string) =>
    integrationConnectionService.cancelAuthorization(integrationId),

  /**
   * #7210 官方命令行(钉钉 dws、企业微信 wecom-cli):在**这台**机器上装好工具、起它自带的登录,回给人看的
   * 授权链接 / 二维码;之后 `cliLoginWait` 一问一答等它登上(每问最多 20 秒)。远程机器上也是那台机器自己跑。
   */
  cliLoginStart: async (integrationId: string) => integrationConnectionService.cliLoginStart(integrationId),
  /** 起登录前先装好工具:一问最多 20 秒,装得慢(远程机器上十来分钟)也不绑在一次调用上。 */
  cliToolPrepare: async (integrationId: string) => integrationConnectionService.cliToolPrepare(integrationId),

  cliLoginWait: async (integrationId: string) => integrationConnectionService.cliLoginWait(integrationId),
  cliLoginProgress: async (integrationId: string) => integrationConnectionService.cliLoginProgress(integrationId),

  /**
   * #7199 / #2104 助理搬家:这台机器上连着哪些集成、怎么配的(不保密的那几项),新家照着逐个重新连接。
   * ❌ 任何凭据。原来的 `exportForMove` / `importFromMove`(连凭据一起搬)已撤:老桌面调到会得 unknown_method,
   * 按它自己的老逻辑报「那一头不支持、账号留在原处」,❌ 把空凭据写进新家。
   */
  moveSummary: async () => summarizeAccountsForMove(moveDeps),
});
