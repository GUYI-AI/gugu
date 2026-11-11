import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { listAgents, userIdFromSupabaseAccessToken } from '@gugu/core';
import { agentsForOwner } from '@gugu/core/local/state/agentOwner';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { triggerConfigSchema } from '@shared/core/automations/config';
import { appKey } from '@shared/extensions/app-identity';
import { BINDING_NAME } from '@shared/extensions/unread-binding';
import { SCHEDULE_OPERATIONS, scheduleControlSchema, type AppBoundSchedules, type AppScheduleControl, type AppScheduleReceipt } from '@shared/extensions/bound-schedules';
import { SESSIONPAGE_SESSION_CACHE_KEY } from '@main/core/sessionpage/sessionpage-session-agent';
import {
  agentScheduleHome,
  applySavedScheduleChanges,
  listAppSchedules,
  planAppScheduleChange,
  settledAppScheduleChange,
  watchAgentSchedules,
  type AgentScheduleHome,
  type ScheduleOutcome,
} from '@main/core/automations/app-agent-schedules';
import { currentAccountAccessToken } from './account-token';
import { extensionsRoot, extensionsService } from './extensions-root';
import {
  commitPanelRequest,
  listPanelSchedules,
  panelAs,
  panelSchedulesPrint,
  personalAssistantOf,
  planPanelChange,
  type PanelHome,
  type PanelOutcome,
  type PanelRequest,
} from './app-bound-schedules-panel';
import { onAssistantPanelChanged } from './assistant-panel-changes';

/**
 * #1928 (API 43) The schedules of the agent an App's binding is with: `gugu.bindings.schedules` / `onSchedulesChanged`
 * (`schedules`, `chat:schedules`) and `controlSchedule` (`schedules:control`, `chat:schedules:control`).
 *
 * Authority, as for the binding's files (app-unread-bindings.ts): the signed-in account's own selection for this installed
 * App, with the action declared and granted — and its conversation the account's private one with an agent the account
 * owns, read as the person. The App never names an owner, agent, session or chat. All of it is checked again after every
 * wait, and once more when a change has been made: an account switch, a withdrawal, a disable, an uninstall or another
 * selection in between and the answer is `denied`.
 *
 * Where the agent lives decides the path, as for the built-in 已安排 panel: on this computer, its schedule store directly;
 * the person's assistant living on another computer or in the cloud, its panel (app-bound-schedules-panel.ts), whose
 * changes its home applies — a receipt says `pending` until it has; any other agent elsewhere, `elsewhere`.
 *
 * Lifecycle is the host's, not the page's: closing or evicting a page stops only what it was told; disabling or
 * uninstalling the App takes its authority and leaves every schedule as it is (whether that should also pause them is a
 * product decision not made here). A change is recorded under the caller's operation id before its effect and answered
 * from that record ever after — the one way a retry is safe. The host keeps no queue of its own: nothing is retried for
 * the App.
 */

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
const denied = (message: string) => coded('denied', message);
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
const NOT_OWN_AGENT = 'The chosen conversation is not your private conversation with an agent of yours';
const ELSEWHERE = 'This agent lives on another computer, which keeps its schedules';

async function account() {
  const token = await currentAccountAccessToken();
  const ownerId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !ownerId) throw denied('Not signed in');
  return { token, ownerId };
}
async function current(ownerId: string) {
  if ((await account()).ownerId !== ownerId) throw denied('Account changed');
}

/**
 * The other one in the chosen conversation — only when it is the person's private conversation with an agent the person
 * owns. Read with the person's token; a read that could not be made is `failed`, never a guess.
 */
async function ownAgentOf(token: string, ownerId: string, chatId: string): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` };
  const chat = createGuguSupabaseClient({ schema: 'chat', headers });
  const [kind, members] = await Promise.all([
    chat.from('chats').select('kind').eq('id', chatId).maybeSingle(),
    chat.from('active_members').select('user_id').eq('chat_id', chatId),
  ]);
  if (kind.error || members.error) throw coded('failed', 'Could not read the chosen conversation');
  const ids = ((members.data ?? []) as { user_id: string }[]).map((row) => row.user_id);
  if (!ids.includes(ownerId)) throw denied('This account is not an active member of the conversation');
  const others = ids.filter((id) => id !== ownerId);
  if ((kind.data as { kind?: unknown } | null)?.kind !== 'dm' || others.length !== 1) throw denied(NOT_OWN_AGENT);
  const owned = await createGuguSupabaseClient({ schema: 'identity', headers })
    .from('active_users').select('id').eq('id', others[0]!).eq('owner_user_id', ownerId).maybeSingle();
  if (owned.error) throw coded('failed', 'Could not verify whose agent it is');
  if (!owned.data) throw denied(NOT_OWN_AGENT);
  return others[0]!;
}

/** That agent's session on this computer, from the roster rows this account may own. */
async function agentSessionHere(ownerId: string, agentId: string): Promise<string | null> {
  const found = new Set(agentsForOwner(await listAgents(process.env, { includeGuests: true }), ownerId)
    .filter((agent) => agent.gugu_user_id === agentId)
    .map((agent) => agent.cache?.[SESSIONPAGE_SESSION_CACHE_KEY])
    .filter((id): id is string => typeof id === 'string' && id.length > 0));
  if (found.size > 1) throw coded('failed', 'This agent is bound to more than one session here');
  return [...found][0] ?? null;
}

type Reached = { scope: string; ownerId: string; token: string; agentId: string; recheck(): Promise<void> };
type Bound =
  | { state: 'unbound' }
  | { state: 'elsewhere' }
  | (Reached & { state: 'ready'; home: AgentScheduleHome })
  | (Reached & { state: 'remote'; panel: PanelHome });

async function boundAgent(extensionId: string, name: string, action: 'schedules' | 'schedules:control'): Promise<Bound> {
  const { token, ownerId } = await account();
  const before = extensionsService().conversationBinding(ownerId, extensionId, name, action);
  if (!before) return { state: 'unbound' };
  const recheck = async () => {
    await current(ownerId);
    if (extensionsService().conversationBinding(ownerId, extensionId, name, action)?.handle !== before.handle) throw denied('Conversation binding changed');
  };
  const reached = (agentId: string): Reached => {
    const identity = extensionsService().identityOf(extensionId);
    if (!identity) throw denied('The installed App has no verified publisher');
    return { scope: `${ownerId}/${appKey(identity)}`, ownerId, token, agentId, recheck };
  };
  const agentId = await ownAgentOf(token, ownerId, before.chatId);
  await recheck();
  const sessionId = await agentSessionHere(ownerId, agentId);
  await recheck();
  const home = sessionId ? await agentScheduleHome(sessionId) : null;
  await recheck();
  const assistant = await personalAssistantOf(token, ownerId);
  await recheck();
  const isAssistant = assistant?.agentId === agentId;
  // Listed here is not living here: a move away that did not finish cleaning up leaves the person's assistant on this
  // computer's roster. Its schedule store here is used only while its home is this computer.
  if (home && (!isAssistant || await isThisComputer(assistant.deviceId))) return { ...reached(agentId), state: 'ready', home };
  // Not here: only the person's assistant has a panel another computer reads and changes, as the built-in list does.
  if (!isAssistant) return { state: 'elsewhere' };
  await recheck();
  return { ...reached(agentId), state: 'remote', panel: { ownerId, assistantId: agentId, deviceId: assistant.deviceId, cloud: panelAs(token, ownerId) } };
}

/** Whether the assistant's home device is this computer; not knowable yet (not signed in to the other machines) = failed. */
async function isThisComputer(deviceId: string): Promise<boolean> {
  const { otherMachines } = await import('@main/core/sessions/session-family');
  try {
    return await otherMachines().isThisDevice(deviceId);
  } catch {
    throw coded('failed', 'Could not tell whether its home is this computer');
  }
}

function nameOf(input: unknown): string {
  const parsed = z.strictObject({ name: z.string().regex(BINDING_NAME) }).safeParse(input);
  if (!parsed.success) throw coded('invalid', 'gugu.bindings takes the binding\'s name, never an agent, chat or account');
  return parsed.data.name;
}

/** `gugu.bindings.schedules(name)`: the bound agent's schedules, or why there are none to show. */
export async function appBoundSchedules(extensionId: string, input: unknown): Promise<AppBoundSchedules> {
  const name = nameOf(input);
  const bound = await boundAgent(extensionId, name, 'schedules').catch((error: unknown) => {
    if (codeOf(error) === 'failed') return { state: 'unavailable' as const };
    throw error;
  });
  if (bound.state !== 'ready' && bound.state !== 'remote') return { name, state: bound.state };
  try {
    const schedules = bound.state === 'ready' ? await listAppSchedules(bound.home) : await listPanelSchedules(bound.panel, bound.recheck);
    await bound.recheck();
    return { name, state: 'ready', schedules };
  } catch (error) {
    if (codeOf(error) !== 'unavailable') throw error;
    await bound.recheck();
    return { name, state: 'unavailable' };
  }
}

/*
 * The record of each operation id (`.app-schedule-receipts.json` beside the installed Apps, by account and installed App):
 * `pending` from just before its effect, `receipt` once answered, and — for a change sent to the assistant's panel — the
 * exact request sent (`panel`), sent again unchanged to learn where it is. Bounded per App; an id older than the last
 * KEPT_PER_APP is forgotten.
 */
const RECEIPTS_FILE = '.app-schedule-receipts.json';
const KEPT_PER_APP = 500;
const RECEIPT_STATUSES = ['applied', 'conflict', 'missing', 'pending', 'failed', 'superseded'] as const;
/** Where an answer can no longer move: anything else is asked of the panel again. */
const SETTLED = new Set<string>(['applied', 'conflict', 'missing', 'superseded']);
const keptSchema = z.object({
  digest: z.string(),
  at: z.number(),
  pending: z.object({ trigger: triggerConfigSchema.optional() }).optional(),
  panel: z.object({ assistantId: z.string(), operationId: z.string(), key: z.string(), expectedRevision: z.string(),
    operation: z.enum(['enable', 'disable', 'remove']), deviceId: z.string() }).optional(),
  receipt: z.object({ operationId: z.string(), op: z.enum(SCHEDULE_OPERATIONS), at: z.string(), status: z.enum(RECEIPT_STATUSES), scheduleId: z.string(),
    revision: z.string().nullable().optional() }).optional(),
});
type Kept = z.infer<typeof keptSchema>;

function readReceipts(): Record<string, Record<string, Kept>> {
  const file = path.join(extensionsRoot(), RECEIPTS_FILE);
  const parsed = z.record(z.string(), z.record(z.string(), keptSchema)).parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  const all = Object.create(null) as Record<string, Record<string, Kept>>;
  for (const [scope, kept] of Object.entries(parsed)) all[scope] = Object.assign(Object.create(null) as Record<string, Kept>, kept);
  return all;
}

function keptFor(scope: string, operationId: string): Kept | undefined {
  const mine = readReceipts()[scope];
  return mine && Object.hasOwn(mine, operationId) ? mine[operationId] : undefined;
}

function keep(scope: string, operationId: string, kept: Kept): void {
  const root = extensionsRoot();
  const all = readReceipts();
  const mine = all[scope] ?? (Object.create(null) as Record<string, Kept>);
  mine[operationId] = kept;
  const ids = Object.keys(mine).sort((a, b) => mine[a]!.at - mine[b]!.at);
  for (const old of ids.slice(0, Math.max(0, ids.length - KEPT_PER_APP))) delete mine[old];
  all[scope] = mine;
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, RECEIPTS_FILE);
  const staging = `${file}.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(staging, `${JSON.stringify(all)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(staging, file);
}

/** One change at a time per account and App: the same operation id asked twice at once is answered once. */
const tails = new Map<string, Promise<unknown>>();
function serial<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const next = (tails.get(scope) ?? Promise.resolve()).catch(() => undefined).then(work);
  tails.set(scope, next);
  void next.finally(() => { if (tails.get(scope) === next) tails.delete(scope); }).catch(() => undefined);
  return next;
}

function digestOf(change: AppScheduleControl): string {
  const entries = Object.entries(change).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(entries)).digest('base64url');
}

/**
 * `gugu.bindings.controlSchedule(name, { operationId, op, … })`: one change to the bound agent's schedules, by the host's
 * own schedule store or — for the assistant living elsewhere — its panel, answered with its receipt. The same operation id
 * again is answered from the record — never a second change; another change under it is `invalid`. A panel change not yet
 * settled is asked of the panel again: `pending` until the assistant's home applies it.
 */
export async function appBoundScheduleControl(extensionId: string, input: unknown): Promise<AppScheduleReceipt> {
  const parsed = scheduleControlSchema.safeParse(input);
  if (!parsed.success) {
    throw coded('invalid', `controlSchedule takes the binding's name, an operationId and one change — never an agent, chat or account (${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')})`);
  }
  const change = parsed.data;
  const bound = await boundAgent(extensionId, change.name, 'schedules:control');
  if (bound.state === 'unbound') throw coded('not-found', `No conversation is chosen for "${change.name}" yet: the person chooses it in the App's permissions`);
  if (bound.state === 'elsewhere') throw coded('elsewhere', ELSEWHERE);
  const { scope, recheck } = bound;
  const digest = digestOf(change);
  const scheduleId = 'scheduleId' in change ? change.scheduleId : '';
  const answer = async (outcome: ScheduleOutcome | PanelOutcome, panel?: PanelRequest, at = new Date().toISOString()): Promise<AppScheduleReceipt> => {
    const receipt = { operationId: change.operationId, op: change.op, at, ...outcome };
    keep(scope, change.operationId, { digest, at: Date.now(), receipt, ...(panel ? { panel } : {}) });
    await recheck();
    return { name: change.name, ...receipt } as AppScheduleReceipt;
  };
  /** A change already sent to the assistant's panel: the request again, unchanged — the panel answers where it is. */
  const fromPanel = async (kept: Kept & { panel: PanelRequest }): Promise<AppScheduleReceipt> => {
    if (kept.panel.assistantId !== bound.agentId) throw denied(NOT_OWN_AGENT);
    const panel: PanelHome = bound.state === 'remote' ? bound.panel
      : { ownerId: bound.ownerId, assistantId: kept.panel.assistantId, deviceId: kept.panel.deviceId, cloud: panelAs(bound.token, bound.ownerId) };
    const outcome = await commitPanelRequest(panel, kept.panel, scheduleId, recheck);
    // Its record at the panel is gone (kept 30 days once settled): the last answer stands.
    if (kept.receipt && (outcome.status === 'conflict' || outcome.status === 'missing')) return { name: change.name, ...kept.receipt } as AppScheduleReceipt;
    return answer(outcome, kept.panel, kept.receipt?.at);
  };
  return serial(scope, async () => {
    const kept = keptFor(scope, change.operationId);
    if (kept && kept.digest !== digest) throw coded('invalid', 'This operationId was already used for another change: use a new one');
    if (kept?.receipt && SETTLED.has(kept.receipt.status)) {
      await recheck();
      return { name: change.name, ...kept.receipt } as AppScheduleReceipt;
    }
    if (kept?.panel) return fromPanel(kept as Kept & { panel: PanelRequest });
    if (bound.state === 'remote') {
      if (kept?.pending) throw coded('elsewhere', 'This change was begun while the assistant lived on this computer: ask again once it does, or read the schedules and decide anew');
      const plan = await planPanelChange(bound.panel, change, recheck);
      await recheck();
      if ('outcome' in plan) return answer(plan.outcome);
      keep(scope, change.operationId, { digest, at: Date.now(), panel: plan.request });
      return answer(await commitPanelRequest(bound.panel, plan.request, scheduleId, recheck), plan.request);
    }
    const { home } = bound;
    await applySavedScheduleChanges(home.sessionId);
    await recheck();
    if (kept?.pending) {
      const settled = await settledAppScheduleChange(home, change, kept.pending, kept.at);
      await recheck();
      if (settled) return answer(settled);
    }
    const plan = await planAppScheduleChange(home, change);
    await recheck();
    if ('outcome' in plan) return answer(plan.outcome);
    keep(scope, change.operationId, { digest, at: Date.now(), pending: plan.pending });
    return answer(await plan.apply());
  });
}

/** Several changes in one go (a change and its next run, a run's steps) are one word to the page. */
export const SCHEDULES_HEARD_AFTER_MS = 50;

/**
 * `gugu.bindings.onSchedulesChanged(name, fn)`'s host half: `hear` whenever the bound agent's schedules change, while the
 * App's authority stands — here, from the schedule store's own events; for the assistant living elsewhere, from the
 * panel's change word, heard only when its schedules or their outstanding changes differ from before. Checked before each
 * word; once the authority is gone the watch stops itself (`ended`) and says nothing.
 */
export async function watchBoundSchedules(extensionId: string, input: unknown, hear: () => void, ended: () => void): Promise<() => void> {
  const name = nameOf(input);
  const bound = await boundAgent(extensionId, name, 'schedules');
  if (bound.state === 'unbound') throw coded('not-found', `No conversation is chosen for "${name}" yet: the person chooses it in the App's permissions`);
  if (bound.state === 'elsewhere') throw coded('elsewhere', ELSEWHERE);
  let stopped = false;
  let queued = false;
  let off = () => {};
  let checks: Promise<unknown> = Promise.resolve();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    off();
    ended();
  };
  let differs = async () => true;
  if (bound.state === 'remote') {
    // An unreadable panel is one word (the page reads again and is told `unavailable`), not one per change word.
    const print = () => panelSchedulesPrint(bound.panel).catch(() => null);
    let last = await print();
    await bound.recheck();
    differs = async () => {
      const now = await print();
      if (now === last) return false;
      last = now;
      return true;
    };
  }
  const changed = () => {
    if (stopped || queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      if (stopped) return;
      checks = checks.then(async () => {
        if (stopped) return;
        await bound.recheck();
        const heard = await differs();
        await bound.recheck();
        if (heard && !stopped) hear();
      }).catch(stop);
    }, SCHEDULES_HEARD_AFTER_MS);
  };
  off = bound.state === 'ready' ? watchAgentSchedules(bound.home.sessionId, changed) : onAssistantPanelChanged(bound.ownerId, bound.agentId, changed);
  return stop;
}
