import { useReplica, type Reading } from '@/lib/replica';
import type { AgentIconAsset, AgentPayload } from '@shared/core/agents/agent-payload';
import { useHostMachine, useHostReplica } from './host-replica';
import { agentIcons, agentMetadata, agentsMetadata, managementAgent, managementAgents } from './agent-replicas';

/**
 * The agents offered for new tasks on the host's machine (name, description, icon, capabilities).
 * #6264 会话 / 新建框在别的机器上:名单与装没装都是那台机器的(一套工作台,同一个控制器)。
 */
export function useAgents(): Reading<AgentPayload[]> {
  return useHostReplica(agentsMetadata, []);
}

/**
 * 资源库 →「智能体」那张列表 —— 与 composer 同一份上架名单（#6099）。
 * #6264 资源库选了别的机器时,问的是那台机器(见 features/library/library-host.ts);离线时不问,手上有上次的就照旧画。
 */
export function useManagementAgents() {
  const { machine, online } = useHostMachine();
  const reading = useReplica(managementAgents, [machine], { read: online });
  return { reading, refetch: () => managementAgents.refresh(machine) };
}

export function useAgent(id: string) {
  const reading = useReplica(agentMetadata, [id]);
  return { reading, refetch: () => agentMetadata.refresh(id) };
}

/** Until its own answer lands, the library list's row stands in (the detail opens at once). */
export function useManagementAgent(id: string) {
  const { machine, online } = useHostMachine();
  const detail = useReplica(managementAgent, [machine, id], { read: online });
  const list = useReplica(managementAgents, [machine], { read: false });
  const row = list.state === 'value' ? list.value.find((agent) => agent.id === id) : undefined;
  const reading: Reading<AgentPayload | null> = detail.state !== 'value' && row
    ? { state: 'value', value: row, stale: true, error: detail.state === 'error' ? detail.error : null, retry: detail.state === 'error' ? detail.retry : () => managementAgent.refresh(machine, id) }
    : detail;
  return reading;
}

/**
 * 图标表:**每个注册过的家**都有一份,与「上架给用户挑」那两道闸无关。
 *
 * ❌ 别改回从 `useAgents()`(= `agents.list()`)里按 id 找 —— 那份名单是「能不能新建」的闸,
 * 本机装了但没上架的家(Amp / Grok / Kimi / Qoder…)不在里面,于是资源库的智能体列表、侧栏会话行、
 * 会话标签、MCP 卡片上这些家全都画不出图标(owner 2026-09-15)。图标是查表,不是入口。
 *
 * `undefined` = not read yet (the icon's slot, ❌ the fallback glyph); `null` = none, or unreadable (an icon has no room
 * to say a failure).
 */
export function useAgentIcon(id: string, enabled = true): AgentIconAsset | null | undefined {
  // `enabled: false`: the caller already holds the asset (a catalog row), so the table is not asked for.
  const icons = useReplica(agentIcons, enabled ? [] : null);
  if (icons.state === 'unknown') return undefined;
  return icons.state === 'value' ? icons.value[id] ?? null : null;
}
