import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryClient, useReplica, type Reading, type Replica } from '@/lib/replica';
import type {
  CreateAutomationParams,
  UpdateAutomationSettingsPatch,
} from '@shared/core/automations/automation';
import { useAutomationsHost, type AutomationsHost } from './automations-host';
import {
  automationLatestRun,
  automationNextRun,
  automationRunCounts,
  automationRunPage,
  automations as automationsModel,
  refreshAutomationRuns,
  watchAutomations,
  type AutomationMachine,
  type RunStatusFilter,
} from './automation-replicas';

/** 这一页看的那台机器('local' = 本机)。 */
function machineOf(host: AutomationsHost): AutomationMachine {
  return host.remote?.deviceId ?? 'local';
}

/**
 * One machine's reading, with that machine's pushes listened to while shown. 别的机器离线就不问(问不到,只会挂满超时),
 * 照旧画上次读到的;变化靠那台机器推来的事件(#6264),❌ 轮询、❌ 切回窗口再问。
 */
function useMachineReplica<A extends [AutomationMachine, ...unknown[]], V>(
  model: Replica<A, V>,
  host: AutomationsHost,
  args: A | null
): Reading<V> {
  const machine = machineOf(host);
  // Declared before the read: a watcher starting here reads again only what was already here, ❌ a first read twice.
  useEffect(() => watchAutomations(machine), [machine]);
  return useReplica(model, args, { read: host.remote?.online !== false });
}

export function useAutomations() {
  const host = useAutomationsHost();
  const api = host.api;
  const machine = machineOf(host);
  const automations = useMachineReplica(automationsModel, host, [machine]);
  const refreshList = () => automationsModel.refresh(machine);

  const create = useMutation({
    mutationFn: (params: CreateAutomationParams) => api.createAutomation(params),
    onSuccess: refreshList,
  }, queryClient);

  const updateSettings = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateAutomationSettingsPatch }) =>
      api.updateAutomationSettings(id, patch),
    onSuccess: refreshList,
  }, queryClient);

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameAutomation(id, name),
    onSuccess: refreshList,
  }, queryClient);

  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setAutomationEnabled(id, enabled),
    onSuccess: refreshList,
  }, queryClient);

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.toggleAutomationEnabled(id, enabled),
    onSuccess: refreshList,
  }, queryClient);

  const runNow = useMutation({
    mutationFn: (id: string) => api.runAutomation(id),
    onSuccess: (_run, id) => refreshAutomationRuns(machine, id),
  }, queryClient);

  const stop = useMutation({
    mutationFn: (runId: string) => api.stopRun(runId),
    onSuccess: () => refreshAutomationRuns(machine),
  }, queryClient);

  const destroy = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: refreshList,
  }, queryClient);

  return {
    automations,
    retry: () => void refreshList(),
    create,
    updateSettings,
    rename,
    setEnabled,
    toggleEnabled,
    runNow,
    stop,
    destroy,
  };
}

export function useScheduledAutomationRun(automationId: string) {
  const host = useAutomationsHost();
  return useMachineReplica(automationNextRun, host, [machineOf(host), automationId]);
}

export function useLatestAutomationRun(automationId: string) {
  const host = useAutomationsHost();
  return useMachineReplica(automationLatestRun, host, [machineOf(host), automationId]);
}

export function useAutomationRunsPaginated(automationId: string, page: number, status: RunStatusFilter) {
  const host = useAutomationsHost();
  return useMachineReplica(automationRunPage, host, [machineOf(host), automationId, page, status]);
}

export function useAutomationRunCounts(automationId: string) {
  const host = useAutomationsHost();
  return useMachineReplica(automationRunCounts, host, [machineOf(host), automationId]);
}

/** Read the run models of one automation again (a retry after a failed read). */
export function useRetryAutomationRuns(automationId: string) {
  const machine = machineOf(useAutomationsHost());
  return () => refreshAutomationRuns(machine, automationId);
}
