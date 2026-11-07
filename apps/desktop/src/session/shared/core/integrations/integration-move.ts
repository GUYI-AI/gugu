// #7199 / #2104 助理搬家时账号类集成在两台机器之间走的形状(主进程 integrations.moveSummary 与渲染层编排共用)。
// 只带「有哪些、怎么配的」:❌ 任何凭据(token、key、密码、授权码)—— 新家逐个提示重新连接。
export type MoveReconnectReason =
  /** 存在这台机器上的账号(邮箱、Notion……):凭据不搬,新家重新连。 */
  | 'account'
  /** 走官方命令行的集成:登录态在那台机器的命令行目录里,新家重新连。 */
  | 'cli'
  /** 有这条记录、本机却没有可读的密钥(gh 命令行代管的账号、密钥库读不出来)。 */
  | 'no-secret';

export type MoveReconnect = {
  integrationId: string;
  accountId?: string;
  displayName?: string;
  isDefault?: boolean;
  /** 表单里不保密的那几项(服务器、端口、用户名……),新家重连时照着填;保密项 ❌ 在这里。 */
  config?: Record<string, string>;
  reason: MoveReconnectReason;
};

/**
 * `moving` 恒为空,留着给老桌面读:老桌面的确认框只认 `moving`(会带走的)和 `reconnect`(要重新连的)两栏,
 * 现在什么都不带走,全在 `reconnect`。新桌面遇到老旧家回的 `moving`(只有名字)同样当成要重新连。
 */
export type IntegrationMoveSummary = {
  moving: { integrationId: string; accountId: string; displayName?: string }[];
  reconnect: MoveReconnect[];
};
