import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';
import { SIDEBAR_STATE_GROUP_ORDER, sidebarStateGroup } from './session-groups';

// 我的 agent 在哪里列出来都是这一个次序:群 / 项目里的「智能体」、通讯录导图与 agent 库,父子树的每一层兄弟。
// 需要你的 → 在跑的 → 其余;同一档里最近交互的在前,再按建的先后,最后按 id —— 次序完全由数据定,❌ 置顶、❌ 名字
// (置顶有三处各管各的、名字各处 collator 不同,都会让同一份 agent 在两处排得不一样)。
// 什么时候重排归列表(lib/heldOrder:指针在上面时不挪),❌ 归这里。

export type AgentOrderRow = {
  id: string;
  presentation?: AgentStatusPresentation | null;
  /** 最后交互时间(ms),新的在前;0 = 不知道。 */
  time: number;
  /** ISO;缺席 = 不知道(别的机器上的会话摘要不带)。 */
  createdAt?: string;
};

/** 需要你 → 在跑 → 其余(sidebarStateGroup 的次序,其余排最后)。 */
export function agentTier(presentation: AgentStatusPresentation | null | undefined): number {
  const group = sidebarStateGroup(presentation ?? null);
  return group === null ? SIDEBAR_STATE_GROUP_ORDER.length : SIDEBAR_STATE_GROUP_ORDER.indexOf(group);
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareAgentRows(a: AgentOrderRow, b: AgentOrderRow): number {
  return (
    agentTier(a.presentation) - agentTier(b.presentation) ||
    b.time - a.time ||
    byText(a.createdAt ?? '', b.createdAt ?? '') ||
    byText(a.id, b.id)
  );
}

export function orderAgentRows<T extends AgentOrderRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareAgentRows);
}
