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
 * What 已安排 (the automations page) and a task's own schedules show of one machine: replicas keyed by the machine
 * (`'local'` = this computer, otherwise its device id). Each machine pushes its changes (automation:changed,
 * automation:run-changed), so every model here is `fresh: Infinity` and refreshed by the watcher below, ❌ polled.
 */

/** `'local'` = this computer; another machine by its device id. */
export type AutomationMachine = string;

const apiOf = (machine: AutomationMachine) => rpcOn(machine === 'local' ? null : machine).automations;
const eventMachineOf = (machine: AutomationMachine) => (machine === 'local' ? null : machine);

export const RUN_PAGE_SIZE = 25;
export type RunStatusFilter = 'done' | 'failed' | 'skipped' | 'all';

export const automations = replica({
  name: 'automations',
  scope: 'account',
  read: (_owner, machine: AutomationMachine): Promise<Automation[]> => apiOf(machine).listAutomations(),
  fresh: Infinity,
});

export const automationNextRun = replica({
  name: 'automationNextRun',
  scope: 'account',
  read: (_owner, machine: AutomationMachine, automationId: string): Promise<AutomationRun | null> =>
    apiOf(machine).getNextScheduledRun(automationId),
  fresh: Infinity,
});

export const automationLatestRun = replica({
  name: 'automationLatestRun',
  scope: 'account',
  read: (_owner, machine: AutomationMachine, automationId: string): Promise<AutomationRun | null> =>
    apiOf(machine).getLatestRun(automationId),
  fresh: Infinity,
});

/** One page of an automation's run history; one row more than a page says whether there is a next one. */
export const automationRunPage = replica({
  name: 'automationRunPage',
  scope: 'account',
  read: (_owner, machine: AutomationMachine, automationId: string, page: number, status: RunStatusFilter): Promise<AutomationRun[]> =>
    apiOf(machine).listAutomationRuns(automationId, RUN_PAGE_SIZE + 1, page * RUN_PAGE_SIZE, status === 'all' ? undefined : status),
  fresh: Infinity,
  keep: 60_000,
});

export const automationRunCounts = replica({
  name: 'automationRunCounts',
  scope: 'account',
  read: (_owner, machine: AutomationMachine, automationId: string) => apiOf(machine).countAutomationRunsByStatus(automationId),
  fresh: Infinity,
});

/** Every schedule a task gave itself on one machine (the sidebar clock, the composer tray). */
export const sessionSchedules = replica({
  name: 'sessionSchedules',
  scope: 'account',
  read: (_owner, machine: AutomationMachine): Promise<SessionSchedule[]> => apiOf(machine).listSessionSchedules(),
  fresh: Infinity,
});

type AnyModel = Replica<[AutomationMachine, ...never[]], unknown>;
const MODELS = [automations, automationNextRun, automationLatestRun, automationRunPage, automationRunCounts, sessionSchedules] as unknown as AnyModel[];

/** The arguments surfaces asked each model for, so a watcher starting again knows which values went unwatched. */
const asked = new Map<string, Map<string, unknown[]>>();

export function noteAsked(model: { name: string }, args: readonly unknown[]): void {
  let byArgs = asked.get(model.name);
  if (!byArgs) asked.set(model.name, (byArgs = new Map()));
  byArgs.set(JSON.stringify(args), [...args]);
}

/** Every run model of one automation (or of every automation of the machine) read again where shown. */
export function refreshAutomationRuns(machine: AutomationMachine, automationId?: string): void {
  void automationNextRun.refresh(machine, automationId);
  void automationLatestRun.refresh(machine, automationId);
  void automationRunPage.refresh(machine, automationId);
  void automationRunCounts.refresh(machine, automationId);
}

// Subscription ownership only (the values live in the replicas): one pair of listeners per machine, however many rows,
// pages and composers read it; the last reader gone takes them off.
const watchers = new Map<AutomationMachine, { readers: number; stop: () => void }>();

export function watchAutomations(machine: AutomationMachine): () => void {
  const existing = watchers.get(machine);
  if (existing) existing.readers += 1;
  else {
    const eventMachine = eventMachineOf(machine);
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
      for (const args of asked.get(model.name)?.values() ?? []) {
        if (args[0] !== machine) continue;
        const typed = args as [AutomationMachine, ...never[]];
        if (model.peek(...typed).state === 'value') void model.refresh(...typed);
      }
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
