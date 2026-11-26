import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config';
import { messageForUser } from '@/lib/userFacingError';
import type { AgentAuthStatus, SubscriptionPlanReading, SubscriptionUsageReading } from '@gugu/session-core/agents/plugins';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { replica, useReplica } from '@/lib/replica';

/** Every subscription reading of a machine (or one provider on it): `refreshTag(SUBSCRIPTIONS, machine?, providerId?)`. */
export const SUBSCRIPTIONS = 'subscriptions';

/**
 * 套餐、用量、连接与登录读数 —— 一份读数一个读模型(这台设备上、按机器和那一家):「订阅」页、资源库「账号」那一行、
 * 新建任务里的面板读的是同一份(product spec「在哪」),❌ 各问各的。机器 null = 这台。
 */

export const SUBSCRIPTION_STALE_MS = 30_000;
type Machine = string | null;

async function readPlan(machine: string | null, providerId: string): Promise<SubscriptionPlanReading> {
  const result = await (await getAgentConfigRuntimeClient(machine)).readSubscription({ providerId });
  if (!result.success) throw new Error(errorText(result.error));
  return result.data;
}

export async function readUsage(machine: string | null, providerId: string, force: boolean, connectionId?: string): Promise<SubscriptionUsageReading> {
  const result = await (await getAgentConfigRuntimeClient(machine)).readSubscriptionUsage({ providerId, force, connectionId });
  if (!result.success) throw new Error(errorText(result.error));
  return result.data;
}

/** A provider's plan on a machine when it has no connections to manage; a connection's plan is `connectionDetails`' (❌ asked twice). */
export const subscriptionPlan = replica({
  name: 'subscriptionPlan',
  scope: 'device',
  tags: [SUBSCRIPTIONS],
  read: (_device: string, machine: Machine, providerId: string) => readPlan(machine, providerId),
  fresh: SUBSCRIPTION_STALE_MS,
  persist: { maxBytes: 1024, maxEntries: 4 },
});

export const subscriptionUsage = replica({
  name: 'subscriptionUsage',
  scope: 'device',
  tags: [SUBSCRIPTIONS],
  read: (_device: string, machine: Machine, providerId: string, connectionId: string | null) => readUsage(machine, providerId, false, connectionId ?? undefined),
  fresh: SUBSCRIPTION_STALE_MS,
});

/** The connections a provider has on a machine. */
export const harnessConnections = replica({
  name: 'harnessConnections',
  scope: 'device',
  tags: [SUBSCRIPTIONS],
  read: async (_device: string, machine: Machine, providerId: string): Promise<HarnessConnection[]> => {
    const result = await (await getAgentConfigRuntimeClient(machine)).listConnections({ providerId });
    if (!result.success) throw new Error(errorText(result.error));
    return result.data;
  },
  fresh: SUBSCRIPTION_STALE_MS,
  persist: { maxBytes: 1024, maxEntries: 4 },
});

/** One connection's sign-in reading and plan (`planError`: the plan could not be read; the sign-in reading still stands). */
export const connectionDetails = replica({
  name: 'connectionDetails',
  scope: 'device',
  tags: [SUBSCRIPTIONS],
  read: async (_device: string, machine: Machine, providerId: string, connectionId: string) => {
    const client = await getAgentConfigRuntimeClient(machine);
    const input = { providerId, connectionId };
    const [status, plan] = await Promise.all([client.refreshAuthStatus({ ...input, ...(providerId === 'antigravity' ? { program: 'antigravity-cli' } : {}) }), client.readSubscription(input)]);
    if (!status.success) throw new Error(errorText(status.error));
    return { status: status.data, plan: plan.success ? plan.data : null, ...(plan.success ? {} : { planError: errorText(plan.error) }) };
  },
  fresh: SUBSCRIPTION_STALE_MS,
  persist: { maxBytes: 1024, maxEntries: 6 },
});

/** A provider's own sign-in on a machine (the credential predicate's reading; the payer is not a credential). */
export const connectionAvailability = replica({
  name: 'connectionAvailability',
  scope: 'device',
  tags: [SUBSCRIPTIONS],
  read: async (_device: string, machine: Machine, providerId: string, connectionId?: string): Promise<AgentAuthStatus> => {
    const result = await (await getAgentConfigRuntimeClient(machine)).refreshAuthStatus({ providerId,
      ...(connectionId !== undefined ? { connectionId } : {}), ...(providerId === 'antigravity' ? { program: 'antigravity-cli' } : {}) });
    if (!result.success) throw new Error('message' in result.error ? result.error.message : result.error.type);
    return result.data;
  },
  fresh: SUBSCRIPTION_STALE_MS,
});

/** Explicit refresh retains original figures and their timestamp if a vendor request fails. */
export async function refreshConnectionUsage(machine: Machine, providerId: string, connectionId: string): Promise<void> {
  const target = subscriptionUsage.at(machine, providerId, connectionId);
  const previous = subscriptionUsage.peek(machine, providerId, connectionId);
  try { target.set(await readUsage(machine, providerId, true, connectionId)); }
  catch (error) {
    const message = errorText(error);
    target.set(previous.state === 'value' && previous.value.kind === 'windows'
      ? { ...previous.value, refreshError: message }
      : { kind: 'unavailable', reason: 'error', message, readAt: Date.now() });
    throw error;
  }
}

/** Refresh each account on the captured device, including accounts that are not selected. */
export async function refreshModelSubscriptions(machine: Machine, providers: readonly string[]): Promise<void> {
  const outcomes = await Promise.allSettled(providers.map(async providerId => {
    await harnessConnections.refresh(machine, providerId);
    const accounts = harnessConnections.peek(machine, providerId);
    if (accounts.state !== 'value') throw new Error('Could not read connections');
    const details = await Promise.allSettled(accounts.value.map(async ({ id }) => {
      await connectionDetails.refresh(machine, providerId, id);
      const detail = connectionDetails.peek(machine, providerId, id);
      if (detail.state !== 'value') throw new Error('Could not read account status');
      if (detail.value.status.kind === 'authenticated' && detail.value.plan?.payer === 'subscription') {
        await refreshConnectionUsage(machine, providerId, id);
      }
    }));
    const failed = details.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (failed) throw failed.reason;
  }));
  const failed = outcomes.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (failed) throw failed.reason;
}

export function useSubscriptionPlan(machine: Machine, agentId: string, enabled = true) {
  return useReplica(subscriptionPlan, enabled ? [machine, agentId] : null);
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
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return messageForUser(error);
  return messageForUser(typeof error === 'string' ? error : JSON.stringify(error));
}
