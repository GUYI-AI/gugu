import { replica } from '@/lib/replica';
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
 * `fresh: Infinity` and follows that machine's events while shown (`watch`, below), ❌ polled.
 */

/** `'local'` = this computer; another machine by its device id. */
export type AutomationMachine = string;

const hostOf = (machine: AutomationMachine) => (machine === 'local' ? null : machine);
const apiOf = (machine: AutomationMachine) => rpcOn(hostOf(machine)).automations;

type MachineEvent = { automationId: string; run?: AutomationRun };

/**
 * A model's feed: its machine's automation events (`changed`: an automation was made, edited or removed; `run`: a run
 * moved, carrying it), one subscription per model and machine while shown; what it held is read again when it starts.
 */
function machineFeed(on: { changed?: (machine: AutomationMachine, event: MachineEvent) => void; run?: (machine: AutomationMachine, event: MachineEvent) => void }) {
  return {
    group: (machine: AutomationMachine) => machine,
    start: (_owner: string, machine: AutomationMachine) => {
      const offs = [
        on.changed ? onMachineEvent(hostOf(machine), automationChangedChannel, (event) => on.changed!(machine, event)) : () => {},
        on.run ? onMachineEvent(hostOf(machine), automationRunChangedChannel, (event) => on.run!(machine, event)) : () => {},
      ];
      return () => offs.forEach((off) => off());
    },
  };
}

export const RUN_PAGE_SIZE = 25;
export type RunStatusFilter = 'done' | 'failed' | 'skipped' | 'all';

export const automations = replica({
  name: 'automations',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine): Promise<Automation[]> => apiOf(machine).listAutomations(),
  fresh: Infinity,
  watch: machineFeed({ changed: (machine) => { void automations.refresh(machine); } }),
});

export const automationNextRun = replica({
  name: 'automationNextRun',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string): Promise<AutomationRun | null> =>
    apiOf(machine).getNextScheduledRun(automationId),
  fresh: Infinity,
  watch: machineFeed({ changed: (machine, { automationId }) => { void automationNextRun.refresh(machine, automationId); }, run: (machine, { automationId }) => { void automationNextRun.refresh(machine, automationId); } }),
});

export const automationLatestRun = replica({
  name: 'automationLatestRun',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string): Promise<AutomationRun | null> =>
    apiOf(machine).getLatestRun(automationId),
  fresh: Infinity,
  // The event carries the run: it is the latest one, ❌ read again.
  watch: machineFeed({ run: (machine, { automationId, run }) => { if (run) automationLatestRun.set([machine, automationId], run); } }),
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
  watch: machineFeed({ run: (machine, { automationId }) => { void automationRunPage.refresh(machine, automationId); } }),
});

export const automationRunCounts = replica({
  name: 'automationRunCounts',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string) => apiOf(machine).countAutomationRunsByStatus(automationId),
  fresh: Infinity,
  watch: machineFeed({ run: (machine, { automationId }) => { void automationRunCounts.refresh(machine, automationId); } }),
});

/** Every schedule a task gave itself on one machine (the sidebar clock, the composer tray). */
export const sessionSchedules = replica({
  name: 'sessionSchedules',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine): Promise<SessionSchedule[]> => apiOf(machine).listSessionSchedules(),
  fresh: Infinity,
  watch: machineFeed({ changed: (machine) => { void sessionSchedules.refresh(machine); }, run: (machine) => { void sessionSchedules.refresh(machine); } }),
});

/** Every run model of one automation (or of every automation of the machine) read again where shown. */
export function refreshAutomationRuns(machine: AutomationMachine, automationId?: string): void {
  void automationNextRun.refresh(machine, automationId);
  void automationLatestRun.refresh(machine, automationId);
  void automationRunPage.refresh(machine, automationId);
  void automationRunCounts.refresh(machine, automationId);
}
