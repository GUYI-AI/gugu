import { replica } from '@/lib/replica';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import type { Automation } from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import {
  automationChangedChannel,
  automationRunChangedChannel,
} from '@shared/core/automations/automationEvents';
import type { SessionSchedule } from '@shared/core/automations/session-schedule';

// What 已安排 and a task's own schedules show of one machine: push-fed (`watch`), ❌ polled.

/** `'local'` = this computer, else a device id. */
export type AutomationMachine = string;

const hostOf = (machine: AutomationMachine) => (machine === 'local' ? null : machine);
const apiOf = (machine: AutomationMachine) => rpcOn(hostOf(machine)).automations;

type MachineEvent = { automationId: string; run?: AutomationRun };

const CHANNELS = { changed: automationChangedChannel, run: automationRunChangedChannel } as const;

/** A machine's feed: each event named reads the entries it concerns again (`refresh`). */
function machineFeed(events: readonly (keyof typeof CHANNELS)[], refresh: (machine: AutomationMachine, event: MachineEvent) => void) {
  return {
    group: (machine: AutomationMachine) => machine,
    start: (_owner: string, machine: AutomationMachine) => {
      const offs = events.map((name) => onMachineEvent(hostOf(machine), CHANNELS[name], (event: MachineEvent) => refresh(machine, event)));
      return () => offs.forEach((off) => off());
    },
  };
}

/** The models of an automation's runs: `refreshTag(RUNS, machine, automationId?)` reads them all again. */
export const RUNS = 'automation-runs';

export const RUN_PAGE_SIZE = 25;
export type RunStatusFilter = 'done' | 'failed' | 'skipped' | 'all';

export const automations = replica({
  name: 'automations',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine): Promise<Automation[]> => apiOf(machine).listAutomations(),
  fresh: Infinity,
  watch: machineFeed(['changed'], (machine) => { void automations.refresh(machine); }),
});

export const automationNextRun = replica({
  name: 'automationNextRun',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string): Promise<AutomationRun | null> =>
    apiOf(machine).getNextScheduledRun(automationId),
  fresh: Infinity,
  tags: [RUNS],
  watch: machineFeed(['changed', 'run'], (machine, { automationId }) => { void automationNextRun.refresh(machine, automationId); }),
});

export const automationLatestRun = replica({
  name: 'automationLatestRun',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string): Promise<AutomationRun | null> =>
    apiOf(machine).getLatestRun(automationId),
  fresh: Infinity,
  tags: [RUNS],
  // The event carries the run: it is the latest one, ❌ read again.
  watch: machineFeed(['run'], (machine, { automationId, run }) => { if (run) automationLatestRun.set([machine, automationId], run); }),
});

/** One row more than a page says whether there is a next one. */
export const automationRunPage = replica({
  name: 'automationRunPage',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string, page: number, status: RunStatusFilter): Promise<AutomationRun[]> =>
    apiOf(machine).listAutomationRuns(automationId, RUN_PAGE_SIZE + 1, page * RUN_PAGE_SIZE, status === 'all' ? undefined : status),
  fresh: Infinity,
  keep: 60_000,
  tags: [RUNS],
  watch: machineFeed(['run'], (machine, { automationId }) => { void automationRunPage.refresh(machine, automationId); }),
});

export const automationRunCounts = replica({
  name: 'automationRunCounts',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine, automationId: string) => apiOf(machine).countAutomationRunsByStatus(automationId),
  fresh: Infinity,
  tags: [RUNS],
  watch: machineFeed(['run'], (machine, { automationId }) => { void automationRunCounts.refresh(machine, automationId); }),
});

export const sessionSchedules = replica({
  name: 'sessionSchedules',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: AutomationMachine): Promise<SessionSchedule[]> => apiOf(machine).listSessionSchedules(),
  fresh: Infinity,
  watch: machineFeed(['changed', 'run'], (machine) => { void sessionSchedules.refresh(machine); }),
});

