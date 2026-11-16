import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config';
import type { AgentAuthStatus, SubscriptionPlanReading, SubscriptionUsageReading } from '@gugu/session-core/agents/plugins';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { replica, useReplica } from '@/lib/replica';

/**
 * 套餐、用量、连接与登录读数 —— 一份读数一个读模型(这台设备上、按机器和那一家):「订阅」页、资源库「账号」那一行、
 * 新建任务里的面板读的是同一份(product spec「在哪」),❌ 各问各的。机器 null = 这台。
 */

export const SUBSCRIPTION_STALE_MS = 30_000;
type Machine = string | null;

export async function readPlan(machine: string | null, providerId: string, connectionId?: string): Promise<SubscriptionPlanReading> {
  const result = await (await getAgentConfigRuntimeClient(machine)).readSubscription({ providerId, connectionId });
  if (!result.success) throw new Error(errorText(result.error));
  return result.data;
}

export async function readUsage(machine: string | null, providerId: string, force: boolean, connectionId?: string): Promise<SubscriptionUsageReading> {
  const result = await (await getAgentConfigRuntimeClient(machine)).readSubscriptionUsage({ providerId, force, connectionId });
  if (!result.success) throw new Error(errorText(result.error));
  return result.data;
}

export const subscriptionPlan = replica({
  name: 'subscriptionPlan',
  scope: 'device',
  read: (_device: string, machine: Machine, providerId: string, connectionId: string | null) => readPlan(machine, providerId, connectionId ?? undefined),
  fresh: SUBSCRIPTION_STALE_MS,
  persist: { maxBytes: 1024, maxEntries: 4 },
});

export const subscriptionUsage = replica({
  name: 'subscriptionUsage',
  scope: 'device',
  read: (_device: string, machine: Machine, providerId: string, connectionId: string | null) => readUsage(machine, providerId, false, connectionId ?? undefined),
  fresh: SUBSCRIPTION_STALE_MS,
});

/** The connections a provider has on a machine. */
export const harnessConnections = replica({
  name: 'harnessConnections',
  scope: 'device',
  read: async (_device: string, machine: Machine, providerId: string): Promise<HarnessConnection[]> => {
    const result = await (await getAgentConfigRuntimeClient(machine)).listConnections({ providerId });
    if (!result.success) throw new Error(errorText(result.error));
    return result.data;
  },
  fresh: SUBSCRIPTION_STALE_MS,
  persist: { maxBytes: 1024, maxEntries: 4 },
});

/** One connection's sign-in reading and plan. */
export const connectionDetails = replica({
  name: 'connectionDetails',
  scope: 'device',
  read: async (_device: string, machine: Machine, providerId: string, connectionId: string) => {
    const client = await getAgentConfigRuntimeClient(machine);
    const input = { providerId, connectionId };
    const [status, plan] = await Promise.all([client.refreshAuthStatus(input), client.readSubscription(input)]);
    if (!status.success) throw new Error(errorText(status.error));
    return { status: status.data, plan: plan.success ? plan.data : null };
  },
  fresh: SUBSCRIPTION_STALE_MS,
  persist: { maxBytes: 1024, maxEntries: 6 },
});

/** A provider's own sign-in on a machine (the credential predicate's reading; the payer is not a credential). */
export const connectionAvailability = replica({
  name: 'connectionAvailability',
  scope: 'device',
  read: async (_device: string, machine: Machine, providerId: string): Promise<AgentAuthStatus> => {
    const result = await (await getAgentConfigRuntimeClient(machine)).refreshAuthStatus({ providerId });
    if (!result.success) throw new Error('message' in result.error ? result.error.message : result.error.type);
    return result.data;
  },
  fresh: SUBSCRIPTION_STALE_MS,
});

/**
 * Read again every subscription reading — of one machine, or of one provider on it (after a sign-in, a switch, an
 * event); without arguments, all of them (the page's refresh button).
 */
export function refreshSubscriptionReadings(machine?: Machine, providerId?: string): Promise<void> {
  const models = [subscriptionPlan, subscriptionUsage, harnessConnections, connectionDetails, connectionAvailability] as const;
  return Promise.all(models.map((model) => model.refresh(machine, providerId))).then(() => undefined);
}

export function useSubscriptionPlan(machine: Machine, agentId: string, connectionId?: string, enabled = true) {
  return useReplica(subscriptionPlan, enabled ? [machine, agentId, connectionId ?? null] : null);
}

export function useSubscriptionUsage(machine: Machine, agentId: string, connectionId: string | undefined, enabled: boolean) {
  return useReplica(subscriptionUsage, enabled ? [machine, agentId, connectionId ?? null] : null);
}

/** 连接动作被主进程拒绝:带着线上的原始错误,界面认得的就按自己的语言写,不认得的照 `message` 显示。 */
export class ConnectionActionError extends Error {
  constructor(readonly failure: unknown) {
    super(errorText(failure));
    this.name = 'ConnectionActionError';
  }
}

/** 因有会话正在工作而没切成:哪一家、几个。旧主进程不带这个字段,返回 null。 */
export function sessionsBusyOf(error: unknown): { providerId: string; count: number } | null {
  if (!(error instanceof ConnectionActionError)) return null;
  const failure = error.failure;
  if (!failure || typeof failure !== 'object' || !('sessionsBusy' in failure)) return null;
  const busy = failure.sessionsBusy;
  if (!busy || typeof busy !== 'object' || !('providerId' in busy) || !('count' in busy)) return null;
  return typeof busy.providerId === 'string' && typeof busy.count === 'number' ? { providerId: busy.providerId, count: busy.count } : null;
}

export function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error);
}
