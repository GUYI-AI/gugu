import { useMutation } from '@tanstack/react-query';
import { queryClient, refreshTag, useReplica, type Reading, type Replica } from '@/lib/replica';
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
  RUNS,
  type AutomationMachine,
  type RunStatusFilter,
} from './automation-replicas';

function machineOf(host: AutomationsHost): AutomationMachine {
  return host.remote?.deviceId ?? null;
}

/** A reading of the automations host's machine (its first argument). 别的机器离线就不问(问不到,只会挂满超时),照旧画上次读到的(#6264)。 */
function useMachineReplica<R extends unknown[], V>(model: Replica<[AutomationMachine, ...R], V>, rest: R): Reading<V> {
  const host = useAutomationsHost();
  return useReplica(model, [machineOf(host), ...rest], { read: host.remote?.online !== false });
}

export function useAutomations() {
  const host = useAutomationsHost();
  const api = host.api;
  const machine = machineOf(host);
  const automations = useMachineReplica(automationsModel, []);
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
    onSuccess: (_run, id) => void refreshTag(RUNS, machine, id),
  }, queryClient);

  const stop = useMutation({
    mutationFn: (runId: string) => api.stopRun(runId),
    onSuccess: () => void refreshTag(RUNS, machine),
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
  return useMachineReplica(automationNextRun, [automationId]);
}

export function useLatestAutomationRun(automationId: string) {
  return useMachineReplica(automationLatestRun, [automationId]);
}

export function useAutomationRunsPaginated(automationId: string, page: number, status: RunStatusFilter) {
  return useMachineReplica(automationRunPage, [automationId, page, status]);
}

export function useAutomationRunCounts(automationId: string) {
  return useMachineReplica(automationRunCounts, [automationId]);
}

export function useRetryAutomationRuns(automationId: string) {
  const machine = machineOf(useAutomationsHost());
  return () => void refreshTag(RUNS, machine, automationId);
}
