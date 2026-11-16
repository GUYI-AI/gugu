import { replica, type Replica } from '@/lib/replica';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import type { Automation } from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import {
  automationChangedChannel,
  automationRunChangedChannel,
} from '@shared/core/automations/automationEvents';
import type { SessionSchedule } from '@shared/core/automations/session-schedule';

/**
 * What 已安排 and a task's own schedules show of one machine. Each machine pushes its changes, so every model here is
 * `fresh: Infinity` and refreshed by the watcher below, ❌ polled.
 */

/** `'local'` = this computer; another machine by its device id. */
export type AutomationMachine = string;

const hostOf = (machine: AutomationMachine) => (machine === 'local' ? null : machine);
const apiOf = (machine: AutomationMachine) => rpcOn(hostOf(machine)).automations;

export const RUN_PAGE_SIZE = 25;
export type RunStatusFilter = 'done' | 'failed' | 'skipped' | 'all';

export const automations = replica({
  name: 'automations',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine): Promise<Automation[]> => apiOf(machine).listAutomations(),
  fresh: Infinity,
});

export const automationNextRun = replica({
  name: 'automationNextRun',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string): Promise<AutomationRun | null> =>
    apiOf(machine).getNextScheduledRun(automationId),
  fresh: Infinity,
});

export const automationLatestRun = replica({
  name: 'automationLatestRun',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string): Promise<AutomationRun | null> =>
    apiOf(machine).getLatestRun(automationId),
  fresh: Infinity,
});

/** One page of an automation's run history; one row more than a page says whether there is a next one. */
export const automationRunPage = replica({
  name: 'automationRunPage',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string, page: number, status: RunStatusFilter): Promise<AutomationRun[]> =>
    apiOf(machine).listAutomationRuns(automationId, RUN_PAGE_SIZE + 1, page * RUN_PAGE_SIZE, status === 'all' ? undefined : status),
  fresh: Infinity,
  keep: 60_000,
});

export const automationRunCounts = replica({
  name: 'automationRunCounts',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string) => apiOf(machine).countAutomationRunsByStatus(automationId),
  fresh: Infinity,
});

/** Every schedule a task gave itself on one machine (the sidebar clock, the composer tray). */
export const sessionSchedules = replica({
  name: 'sessionSchedules',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine): Promise<SessionSchedule[]> => apiOf(machine).listSessionSchedules(),
  fresh: Infinity,
});

type AnyModel = Replica<[AutomationMachine, ...never[]], unknown>;
const MODELS = [automations, automationNextRun, automationLatestRun, automationRunPage, automationRunCounts, sessionSchedules] as unknown as AnyModel[];

/** Every run model of one automation (or of every automation of the machine) read again where shown. */
export function refreshAutomationRuns(machine: AutomationMachine, automationId?: string): void {
  void automationNextRun.refresh(machine, automationId);
  void automationLatestRun.refresh(machine, automationId);
  void automationRunPage.refresh(machine, automationId);
  void automationRunCounts.refresh(machine, automationId);
}

// One pair of listeners per machine, however many readers; the last reader gone takes them off.
const watchers = new Map<AutomationMachine, { readers: number; stop: () => void }>();

export function watchAutomations(machine: AutomationMachine): () => void {
  const existing = watchers.get(machine);
  if (existing) existing.readers += 1;
  else {
    const eventMachine = hostOf(machine);
    const offChanged = onMachineEvent(eventMachine, automationChangedChannel, ({ automationId }) => {
      void automations.refresh(machine);
      void automationNextRun.refresh(machine, automationId);
      void sessionSchedules.refresh(machine);
    });
    const offRun = onMachineEvent(eventMachine, automationRunChangedChannel, ({ automationId, run }) => {
      // The event carries the run: it is the latest one, ❌ read again.
      if (automationLatestRun.key(machine, automationId)) automationLatestRun.set([machine, automationId], run);
      void automationNextRun.refresh(machine, automationId);
      void automationRunPage.refresh(machine, automationId);
      void automationRunCounts.refresh(machine, automationId);
      void sessionSchedules.refresh(machine);
    });
    watchers.set(machine, { readers: 1, stop: () => { offChanged(); offRun(); } });
    // Values already here were read while nobody listened to this machine: read them again now.
    for (const model of MODELS) {
      for (const { args, reading } of model.entries(machine)) if (reading.state === 'value') void model.refresh(...args);
    }
  }
  return () => {
    const entry = watchers.get(machine);
    if (!entry) return;
    entry.readers -= 1;
    if (entry.readers > 0) return;
    entry.stop();
    watchers.delete(machine);
  };
}
