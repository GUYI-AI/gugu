import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { encodeTypedId } from '@gugu/core/shared/typedId.mjs';
import { sessionpageAcceptsInboundMessages } from '@gugu/session-plugins/agents';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { tapMainEvents } from '@main/lib/events';
import { isSpentOneTimeAutomation, type Automation } from '@shared/core/automations/automation';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import { automationChangedChannel, automationRunChangedChannel } from '@shared/core/automations/automationEvents';
import type { TriggerConfig } from '@shared/core/automations/config';
import type { AppBoundSchedule, AppScheduleControl } from '@shared/extensions/bound-schedules';
import { MAX_ACTIVE_SCHEDULES_PER_SESSION, runAgentScheduleAction } from './agent-schedules';
import { prepareAgentScheduleChanges } from './assistant-panel-schedule-preparation';
import { automationsService } from './automations-service';
import { deleteAndTell, setEnabledAndTell, tellAgent, updateSettingsAndTell } from './person-schedule-changes';
import { getAutomation, listAgentSchedules, listAutomationRunCleanupTargets } from './repo';
import { resolveScheduleTrigger } from './schedule-time';

/**
 * #1928 An App's view of, and changes to, the schedules one agent session on this computer set for itself — the person's
 * own agent, found by the host from the App's binding (extensions/app-bound-schedules.ts). Nothing here keeps a second
 * scheduler or a queue: a list reads the store the scheduler reads, after the saved changes it would apply first
 * (`prepareAgentScheduleChanges`, as before a due run); a change is the person's own (`person-schedule-changes.ts`, the
 * 已安排 page's), and a registration is the agent's own `schedule_create`. A run already under way is never stopped.
 */

/** The agent's session here, as a schedule needs it; null when it is not here, or archived. */
export type AgentScheduleHome = { sessionId: string; projectId: string; provider: string | null; runtime: string | null };

export type ScheduleOutcome =
  | { status: 'applied'; scheduleId: string; revision: string | null }
  | { status: 'conflict'; scheduleId: string; revision: string }
  | { status: 'missing'; scheduleId: string };

/** What an interrupted change is recognised by when its operation id is asked again: the time it resolved to. */
export type PendingScheduleChange = { trigger?: TriggerConfig };

/** Either what the change already is (no effect), or the one effect to make — checked, before anything is written. */
export type ScheduleChangePlan = { outcome: ScheduleOutcome } | { pending: PendingScheduleChange; apply(): Promise<ScheduleOutcome> };

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
const iso = (at: number | null | undefined) => (at == null ? null : new Date(at).toISOString());
const IN_FLIGHT = new Set(['creating_session', 'launching_session', 'starting_agent']);

export async function agentScheduleHome(sessionId: string): Promise<AgentScheduleHome | null> {
  const [row] = await db
    .select({ id: sessions.id, projectId: sessions.projectId, provider: sessions.provider, runtime: sessions.runtime, archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row && row.archivedAt == null ? { sessionId: row.id, projectId: row.projectId, provider: row.provider ?? null, runtime: row.runtime ?? null } : null;
}

/** Opaque, and different whenever anything the App sees or decides on is: a change names the one it was decided on. */
export function scheduleRevision(automation: Automation): string {
  const facts = [automation.updatedAt, automation.enabled, automation.name, automation.agentConfig?.prompt ?? '', automation.triggerConfig ?? null];
  return createHash('sha256').update(JSON.stringify(facts)).digest('base64url').slice(0, 22);
}

function lastRunOf(run: AutomationRun | null): AppBoundSchedule['lastRun'] {
  if (!run) return null;
  const status = run.status === 'done' || run.status === 'failed' || run.status === 'skipped' ? run.status : 'running';
  return { status, at: iso(run.finishedAt ?? run.startedAt ?? run.scheduledAt) };
}

export function appScheduleOf(automation: Automation, next: AutomationRun | null, last: AutomationRun | null): AppBoundSchedule {
  const trigger = automation.triggerConfig;
  return {
    id: encodeTypedId('schedule', automation.id),
    revision: scheduleRevision(automation),
    title: automation.name,
    prompt: automation.agentConfig?.prompt ?? '',
    at: trigger?.at != null ? iso(trigger.at) : null,
    cron: trigger && trigger.at == null ? trigger.expr : null,
    tz: trigger?.tz ?? null,
    state: automation.enabled ? 'active' : isSpentOneTimeAutomation(automation) ? 'ended' : 'paused',
    nextRunAt: automation.enabled ? iso(next?.scheduledAt) : null,
    lastRun: lastRunOf(last),
    updatedAt: iso(automation.updatedAt)!,
  };
}

/** The saved changes the scheduler applies before a due run (the assistant panel's), applied first here too. */
export async function applySavedScheduleChanges(sessionId: string): Promise<void> {
  const blocked = await prepareAgentScheduleChanges();
  if (blocked.has(sessionId)) throw coded('unavailable', 'Saved changes to these schedules are not applied yet: try again later');
}

export async function listAppSchedules(home: AgentScheduleHome): Promise<AppBoundSchedule[]> {
  await applySavedScheduleChanges(home.sessionId);
  return Promise.all((await listAgentSchedules(home.sessionId)).map(async (automation) => {
    const [next, last] = await Promise.all([automationsService.getNextScheduledRun(automation.id), automationsService.getLatestRun(automation.id)]);
    return appScheduleOf(automation, next, last);
  }));
}

/** A schedule of this agent's by the id the App holds; another agent's or none is the same answer. */
async function ownSchedule(home: AgentScheduleHome, scheduleId: string): Promise<Automation | null> {
  const automation = await getAutomation(scheduleId.slice('schedule:'.length).toLowerCase());
  return automation?.agentSessionId === home.sessionId ? automation : null;
}

function triggerOf(change: { at?: string; cron?: string; tz?: string }): TriggerConfig | undefined {
  if (change.at === undefined && change.cron === undefined && change.tz === undefined) return undefined;
  try {
    return resolveScheduleTrigger({ at: change.at, cron: change.cron, tz: change.tz });
  } catch (error) {
    throw coded('invalid', error instanceof Error ? error.message : String(error));
  }
}

const sameTrigger = (a: TriggerConfig | undefined, b: TriggerConfig | undefined) =>
  (a?.at ?? null) === (b?.at ?? null) && (a?.expr ?? '') === (b?.expr ?? '') && (a?.tz ?? null) === (b?.tz ?? null);

async function applied(id: string): Promise<ScheduleOutcome> {
  const automation = await getAutomation(id);
  return { status: 'applied', scheduleId: encodeTypedId('schedule', id), revision: automation ? scheduleRevision(automation) : null };
}

/**
 * Decide a change on what is there now. A stale revision is a conflict and another agent's schedule is missing — both
 * answers, nothing changed; a change the store would refuse is `invalid` before anything is written.
 */
export async function planAppScheduleChange(home: AgentScheduleHome, change: AppScheduleControl): Promise<ScheduleChangePlan> {
  if (change.op === 'register') {
    const trigger = triggerOf(change);
    if (!trigger) throw coded('invalid', 'register needs a time: at (one time) or cron (repeating)');
    // Due, it is a message to that session (as the agent's own schedule_create checks): a leg taking none could not get it.
    if (home.provider && !sessionpageAcceptsInboundMessages(home.provider, home.runtime === 'acp' ? 'acp' : 'tui')) {
      throw coded('invalid', 'This agent takes no messages where it runs: a schedule could not reach it');
    }
    const active = (await listAgentSchedules(home.sessionId)).filter((automation) => automation.enabled).length;
    if (active >= MAX_ACTIVE_SCHEDULES_PER_SESSION) throw coded('invalid', `This agent already has ${active} active schedules (at most ${MAX_ACTIVE_SCHEDULES_PER_SESSION})`);
    return {
      pending: { trigger },
      apply: async () => {
        const row = await runAgentScheduleAction(
          { sessionId: home.sessionId, projectId: home.projectId, provider: home.provider },
          { action: 'schedule_create', prompt: change.prompt, title: change.title, at: change.at, cron: change.cron, tz: change.tz },
        ) as { schedule_id: string };
        const id = row.schedule_id.slice('schedule:'.length);
        const automation = await getAutomation(id);
        if (automation) await tellAgent({ kind: 'added', automation, nextRunAt: (await automationsService.getNextScheduledRun(id))?.scheduledAt ?? null });
        return applied(id);
      },
    };
  }
  const automation = await ownSchedule(home, change.scheduleId);
  if (!automation) return { outcome: { status: 'missing', scheduleId: change.scheduleId } };
  const revision = scheduleRevision(automation);
  if (revision !== change.revision) return { outcome: { status: 'conflict', scheduleId: change.scheduleId, revision } };
  const { id } = automation;
  if (change.op === 'pause') {
    return { pending: {}, apply: async () => { if (automation.enabled) await setEnabledAndTell(id, false); return applied(id); } };
  }
  if (change.op === 'resume') {
    if (!automation.enabled && isSpentOneTimeAutomation(automation)) throw coded('invalid', 'This one-time schedule\'s moment has passed: it cannot be turned on again');
    return { pending: {}, apply: async () => { if (!automation.enabled) await setEnabledAndTell(id, true); return applied(id); } };
  }
  if (change.op === 'remove') {
    if ((await listAutomationRunCleanupTargets(id)).some((run) => IN_FLIGHT.has(run.status))) throw busy();
    return {
      pending: {},
      apply: async () => {
        await deleteAndTell(id).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : '';
          throw message === 'automation_runs_active' || message === 'automation_deletion_in_progress' ? busy() : error;
        });
        return { status: 'applied', scheduleId: change.scheduleId, revision: null };
      },
    };
  }
  const trigger = triggerOf(change);
  if (!trigger && change.title === undefined) throw coded('invalid', 'update changes the title, the time (at or cron), or both');
  return {
    pending: trigger ? { trigger } : {},
    apply: async () => {
      if (change.title !== undefined && change.title !== automation.name) await automationsService.renameAutomation(id, change.title);
      // What it asks stays the agent's own (the store refuses it): only the time moves, and the agent is told it did.
      if (trigger && !sameTrigger(trigger, automation.triggerConfig)) await updateSettingsAndTell(id, { triggerConfig: trigger });
      return applied(id);
    },
  };
}

function busy() {
  return coded('unavailable', 'A run of this schedule is under way and is not stopped: remove the schedule once it ends');
}

/**
 * A change whose operation id was written down as under way but never answered (the host stopped, or the effect threw):
 * whether its effect is there. Null: it is not, and it is decided again as new.
 */
export async function settledAppScheduleChange(home: AgentScheduleHome, change: AppScheduleControl, pending: PendingScheduleChange, since: number): Promise<ScheduleOutcome | null> {
  if (change.op === 'register') {
    const made = (await listAgentSchedules(home.sessionId)).find((automation) => automation.createdAt >= since
      && automation.agentConfig?.prompt === change.prompt && sameTrigger(automation.triggerConfig, pending.trigger));
    return made ? applied(made.id) : null;
  }
  const automation = await ownSchedule(home, change.scheduleId);
  if (change.op === 'remove') return automation ? null : { status: 'applied', scheduleId: change.scheduleId, revision: null };
  if (!automation) return null;
  if (change.op === 'pause') return automation.enabled ? null : applied(automation.id);
  if (change.op === 'resume') return automation.enabled ? applied(automation.id) : null;
  const titled = change.title === undefined || automation.name === change.title;
  return titled && (!pending.trigger || sameTrigger(automation.triggerConfig, pending.trigger)) ? applied(automation.id) : null;
}

/**
 * Told whenever one of this session's schedules, or one of their runs, changes — as the 已安排 list hears it. Returns the
 * stop. One that was deleted is still told, by the ids already seen.
 */
export function watchAgentSchedules(sessionId: string, changed: () => void): () => void {
  const mine = new Set<string>();
  let stopped = false;
  void listAgentSchedules(sessionId).then((list) => list.forEach((automation) => mine.add(automation.id)), () => undefined);
  const off = tapMainEvents((channel, data) => {
    if (stopped || (channel !== automationChangedChannel.name && channel !== automationRunChangedChannel.name)) return;
    const id = (data as { automationId?: unknown } | null)?.automationId;
    if (typeof id !== 'string') return;
    if (mine.has(id)) {
      changed();
      return;
    }
    void getAutomation(id).then((automation) => {
      if (stopped || automation?.agentSessionId !== sessionId) return;
      mine.add(id);
      changed();
    }, () => undefined);
  });
  return () => {
    stopped = true;
    off();
  };
}
