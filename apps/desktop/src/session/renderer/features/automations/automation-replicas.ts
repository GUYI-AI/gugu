import { replica, valueOf } from '@/lib/replica';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import type { Automation } from '@shared/core/automations/automation';
import type { AutomationRun, AutomationRunHeads } from '@shared/core/automations/automation-run';
import {
  automationChangedChannel,
  automationRunChangedChannel,
} from '@shared/core/automations/automationEvents';
import type { SessionSchedule } from '@shared/core/automations/session-schedule';

// What 已安排 and a task's own schedules show of one machine: push-fed (`watch`), ❌ polled.

/** null = this computer, else a device id (as every machine reading, @@@agent-readings). */
export type AutomationMachine = string | null;

const apiOf = (machine: AutomationMachine) => rpcOn(machine).automations;

type MachineEvent = { automationId: string; run?: AutomationRun };

/** A machine's push-fed reading: asked even while the browser says offline, current until its feed says otherwise. */
const ofMachine = { scope: 'account', networkMode: 'always', fresh: Infinity } as const;

const CHANNELS = { changed: automationChangedChannel, run: automationRunChangedChannel } as const;

/** A machine's feed: each event named reads the entries it concerns again (`refresh`). */
function machineFeed(events: readonly (keyof typeof CHANNELS)[], refresh: (machine: AutomationMachine, event: MachineEvent) => void) {
  return {
    group: (machine: AutomationMachine) => machine,
    start: (_owner: string, machine: AutomationMachine) => {
      const offs = events.map((name) => onMachineEvent(machine, CHANNELS[name], (event: MachineEvent) => refresh(machine, event)));
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
  ...ofMachine,
  read: (_owner, machine: AutomationMachine): Promise<Automation[]> => apiOf(machine).listAutomations(),
  watch: machineFeed(['changed'], (machine) => { void automations.refresh(machine); }),
});

/** Every automation's latest and next run on a machine, one read for the whole page (❌ two reads per row). */
export const automationRunHeads = replica({
  name: 'automationRunHeads',
  ...ofMachine,
  read: (_owner, machine: AutomationMachine): Promise<AutomationRunHeads> => apiOf(machine).listRunHeads(),
  tags: [RUNS],
  // The event carries the run: a started or finished one is that automation's latest, ❌ read again. Only a change to
  // what is scheduled next (or to the automation itself) reads them again.
  watch: machineFeed(['changed', 'run'], (machine, { automationId, run }) => {
    const shown = valueOf(automationRunHeads.peek(machine))?.[automationId];
    if (!run || run.status === 'scheduled' || shown?.next?.id === run.id) return void automationRunHeads.refresh(machine);
    automationRunHeads.set([machine], (heads) => heads && { ...heads, [automationId]: { latest: run, next: heads[automationId]?.next ?? null } });
  }),
});

/** One row more than a page says whether there is a next one. */
export const automationRunPage = replica({
  name: 'automationRunPage',
  ...ofMachine,
  read: (_owner, machine: AutomationMachine, automationId: string, page: number, status: RunStatusFilter): Promise<AutomationRun[]> =>
    apiOf(machine).listAutomationRuns(automationId, RUN_PAGE_SIZE + 1, page * RUN_PAGE_SIZE, status === 'all' ? undefined : status),
  keep: 60_000,
  tags: [RUNS],
  watch: machineFeed(['run'], (machine, { automationId }) => { void automationRunPage.refresh(machine, automationId); }),
});

export const automationRunCounts = replica({
  name: 'automationRunCounts',
  ...ofMachine,
  read: (_owner, machine: AutomationMachine, automationId: string) => apiOf(machine).countAutomationRunsByStatus(automationId),
  tags: [RUNS],
  watch: machineFeed(['run'], (machine, { automationId }) => { void automationRunCounts.refresh(machine, automationId); }),
});

export const sessionSchedules = replica({
  name: 'sessionSchedules',
  ...ofMachine,
  read: (_owner, machine: AutomationMachine): Promise<SessionSchedule[]> => apiOf(machine).listSessionSchedules(),
  watch: machineFeed(['changed', 'run'], (machine) => { void sessionSchedules.refresh(machine); }),
});

