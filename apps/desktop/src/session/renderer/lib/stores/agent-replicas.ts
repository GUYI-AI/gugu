import type { HarnessModelCredentialStatus } from '@gugu/session-core/agents/plugins';
import type { AgentModelCatalogAnswer } from '@main/core/agents/platform-model-catalog-hook';
import { refreshTag, replica } from '@/lib/replica';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import type {
  AgentIconAsset,
  AgentInstallationStatus,
  AgentPayload,
  AgentSettings,
  InstallSourceVersions,
} from '@shared/core/agents/agent-payload';
import { agentCapabilitiesChangedChannel } from '@shared/core/agents/agentEvents';
import { agentInstallationStatusUpdatedChannel } from '@shared/events/appEvents';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';

/**
 * @@@agent-readings — what a machine (null = this computer) says about its agents. All derive from its install state, so
 * an install change refreshes the whole family (`refreshAgentReadings`; a prefix invalidation leaked #2802, #5605, #5719).
 * Every model of a machine takes the machine first (`refreshTag(AGENT_READINGS, machine)`).
 */
type Machine = string | null;
const AGENT_READINGS = 'agent-readings';
/** A machine's reading: asked even while the browser says offline (the machine answers, or the read fails loud). */
const ofMachine = { scope: 'account', networkMode: 'always', tags: [AGENT_READINGS] } as const;

/** Then the reading is an error (❌ unknown for ever); the pause between is react-query's own (1 s, 2 s, 4 s). */
const RETRIES = 3;

export const agentsMetadata = replica({
  name: 'agentsMetadata',
  ...ofMachine,
  read: (_owner, machine: Machine) => rpcOn(machine).agents.list() as Promise<AgentPayload[]>,
  // Another machine's list changes by what someone did in its terminal (no push).
  fresh: 30_000,
});

export const managementAgents = replica({
  name: 'managementAgents',
  ...ofMachine,
  read: (_owner, machine: Machine) => rpcOn(machine).agents.listManagement() as Promise<AgentPayload[]>,
  fresh: 30_000,
});

export const managementAgent = replica({
  name: 'managementAgent',
  ...ofMachine,
  read: (_owner, machine: Machine, id: string) => rpcOn(machine).agents.getManagement(id) as Promise<AgentPayload | null>,
  retry: RETRIES,
});

export const agentMetadata = replica({
  name: 'agentMetadata',
  scope: 'device',
  read: (_owner, id: string) => rpc.agents.get(id) as Promise<AgentPayload | null>,
  fresh: 5 * 60_000,
});

export const agentIcons = replica({
  name: 'agentIcons',
  scope: 'device',
  read: () => rpc.agents.listIcons() as Promise<Record<string, AgentIconAsset>>,
  fresh: Infinity,
});

/** Models a harness runs, and the host's own gate for the Gugu group (`gugu`). Main answers from memory: every mount asks (#7081). */
export const harnessModelCatalog = replica({
  name: 'harnessModelCatalog',
  ...ofMachine,
  read: (_owner, machine: Machine, providerId: string, leg: SessionpageLeg) =>
    rpcOn(machine).agents.modelCatalog(providerId, leg) as Promise<AgentModelCatalogAnswer>,
  refreshOnFocus: true,
  refreshEvery: (lookup) => (lookup?.refreshing ? 700 : false),
  // Opening a menu asks again; a read already on its way answers it (the host decides whether to probe again).
  refreshJoinsRead: true,
});

/** Native facts for one explicitly selected model; never written into the default harness catalog. */
export const targetModelCatalog = replica({
  name: 'targetModelCatalog',
  ...ofMachine,
  read: (_owner, machine: Machine, providerId: string, leg: SessionpageLeg, model: string) =>
    rpcOn(machine).agents.targetModelCatalog(providerId, leg, model),
  refreshOnFocus: false,
});

export const harnessModelCredential = replica({
  name: 'harnessModelCredential',
  ...ofMachine,
  // #4956 a failure is logged by the replica; its reader turns it into "cannot tell".
  read: async (_owner, machine: Machine, providerId: string, modelId: string): Promise<HarnessModelCredentialStatus> => {
    const result = await (await getAgentConfigRuntimeClient(machine)).modelCredential({ providerId, modelId });
    if (!result.success) throw new Error(`modelCredential(${providerId}, ${modelId}) failed`, { cause: result.error });
    return result.data;
  },
  fresh: 60_000,
});

export const agentInstallationStatus = replica({
  name: 'agentInstallationStatus',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: Machine) => rpcOn(machine).agents.listAgentInstallationStatus() as Promise<AgentInstallationStatus[]>,
  fresh: 30_000,
  retry: RETRIES,
});

export const installSourceVersions = replica({
  name: 'installSourceVersions',
  ...ofMachine,
  read: (_owner, machine: Machine, id: string) =>
    rpcOn(machine).agents.getInstallSourceVersions(id as never) as Promise<InstallSourceVersions>,
  fresh: 30 * 60_000,
  retry: RETRIES,
});

export const agentSettings = replica({
  name: 'agentSettings',
  ...ofMachine,
  read: (_owner, machine: Machine, id: string) => rpcOn(machine).agents.getSettings(id) as Promise<AgentSettings | null>,
  fresh: 60_000,
});

/**
 * 装完 / 卸完 / 重新检测之后,**所有从安装状态派生的读数一次全重读**。`keepStatus`:status 刚由推送手工打准,
 * 连它一起重读会把刚打的补丁冲掉。
 *
 * 为什么按标签,而不是一条条列:这个形状已经漏过四次,每次都是同一个症状 —— 主进程那边已经是新的,界面还捧着
 * 旧的,用户要么等 fresh 过期、要么切走再切回、要么重启应用:
 *   · #2802 漏了 agent 列表(选择器一直挂「尚未安装」好几分钟)
 *   · 漏了 install-source-versions(点了「检查更新」,数字纹丝不动)
 *   · #5605 漏了模型目录
 *   · #5719 漏了 management 列表(资源库→智能体那张列表的「已安装/未安装」标签,owner 真机实测:装完必须切换
 *     页面或重启才更新)
 *
 * 逐条列举要求每加一个派生读数就记得回来补一行,而四次实证说明没人记得住。所以一台机器的每个读数都带
 * `AGENT_READINGS`(`ofMachine`)并把机器放在第一个参数,这里按标签整体重读 —— 「新加的读数忘了登记」这一类
 * bug 归零。❌ 不要回到逐条列举。代价可控:只有挂着的读数会重读,没在屏幕上的只是标脏。
 */
export function refreshAgentReadings(machine: Machine, options: { keepStatus?: boolean } = {}): Promise<void> {
  return Promise.all([
    refreshTag(AGENT_READINGS, machine),
    ...(options.keepStatus ? [] : [agentInstallationStatus.refresh(machine)]),
    ...(machine === null ? [agentMetadata.refresh(), agentIcons.refresh()] : []),
  ]).then(() => undefined);
}

/** Wired once per document. */
export function wireAgentReadings(): () => void {
  const offs = [
    events.on(agentCapabilitiesChangedChannel, () => {
      void agentsMetadata.refresh(null);
      void agentMetadata.refresh();
    }),
    events.on(agentInstallationStatusUpdatedChannel, (event: AgentInstallationStatus) => {
      if (agentInstallationStatus.key(null)) {
        agentInstallationStatus.set([null], (statuses) => {
          if (!statuses) return undefined;
          const index = statuses.findIndex((status) => status.id === event.id);
          return index === -1 ? [...statuses, event] : statuses.map((status, at) => (at === index ? event : status));
        });
      }
      void refreshAgentReadings(null, { keepStatus: true });
    }),
  ];
  return () => offs.forEach((off) => off());
}
