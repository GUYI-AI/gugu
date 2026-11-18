import type { AgentPayload } from '@shared/core/agents/agent-payload';

/** 推荐的三家在各自组里排最前 —— 只影响顺序,组头不再说「推荐」(owner 2026-09-22)。 */
const RECOMMENDED_IDS = new Set(['claude', 'codex', 'pi']);

/**
 * 智能体的先后:推荐的三家在前，其余按名字。资源库智能体页与设置「订阅」页同一种排法(#2507,owner 2026-11-12
 * 「订阅和资源库的 Agent 其实是不统一的，但按理说应该统一才对」)—— ❌ 两处各留一份名单。
 */
export function compareAgents(a: Pick<AgentPayload, 'id' | 'name'>, b: Pick<AgentPayload, 'id' | 'name'>): number {
  return Number(RECOMMENDED_IDS.has(b.id)) - Number(RECOMMENDED_IDS.has(a.id)) || a.name.localeCompare(b.name);
}

/** 「已安装」那一组:装上了的(读数不是「没找到」),装了但起不来的也算在内(#6101)。 */
export function isInstalledAgent(agent: Pick<AgentPayload, 'reading'>): boolean {
  return agent.reading !== 'not-detected';
}
