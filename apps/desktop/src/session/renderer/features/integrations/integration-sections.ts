/**
 * 资源库 → 集成的分组(11-07 资源库盘点):已添加的在上;没添加的分两组 ——
 * agent 能直接用的(给会话工具、或官方命令行),和只在咕咕界面里用的(issue 关联、GitHub 的项目与 PR)。
 * `agentUse` 是主进程的判定;老 server / 只有摘要的那台机器不给 ⇒ 不知道,照旧算进「可用」,❌ 猜成仅界面。
 */
export type SectionedIntegration = { isConfigured: boolean; isConfigurationKnown: boolean; agentUse?: boolean };

export function integrationSections<T extends SectionedIntegration>(items: readonly T[]) {
  return {
    connected: items.filter((item) => item.isConfigured),
    available: items.filter((item) => item.isConfigurationKnown && !item.isConfigured && item.agentUse !== false),
    uiOnly: items.filter((item) => item.isConfigurationKnown && !item.isConfigured && item.agentUse === false),
  };
}
