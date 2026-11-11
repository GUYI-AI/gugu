import { z } from 'zod';
import { BINDING_NAME } from './unread-binding';

/**
 * #1928 (API 43): when the conversation the person chose for an App's binding is their private conversation with one of
 * their own agents, the binding's `schedules` action lists that agent's 已安排 (`chat:schedules`) and `schedules:control`
 * registers, updates, pauses, resumes and removes them (`chat:schedules:control`). The host keeps the one scheduler and the
 * one executor; the App sees schedules by their stable ids and revisions, and every change goes through the host's own
 * schedule store, never an App-side queue.
 */
export const BOUND_SCHEDULES_API_VERSION = 43;

/** One schedule as the App sees it: never the session, the agent's id or the chat. Times are ISO 8601 instants. */
export type AppBoundSchedule = {
  /** `schedule:<id>`, the one the agent's own `schedule_*` tools use; kept through pause, resume and update. */
  id: string;
  /** Opaque; changes whenever the schedule does. A change names the revision it was decided on. */
  revision: string;
  title: string;
  /** What the agent is told when it is due. Only the agent itself changes it. */
  prompt: string;
  at: string | null;
  cron: string | null;
  tz: string | null;
  /** `ended`: a one-time schedule whose moment has passed. */
  state: 'active' | 'paused' | 'ended';
  nextRunAt: string | null;
  lastRun: { status: 'running' | 'done' | 'failed' | 'skipped'; at: string | null } | null;
  updatedAt: string;
};

/**
 * `gugu.bindings.schedules(name)`. `unbound`: no conversation chosen yet. `elsewhere`: an agent other than the person's
 * assistant lives on another computer, whose host keeps its schedules (the assistant's are read from its panel wherever it
 * lives, as the built-in list does). `unavailable`: they cannot be read now (saved changes not yet applied, the assistant's
 * home has not published them, a change to them is unresolved, the database or the cloud did not answer) — try again later.
 * None of them is an empty list.
 */
export type AppBoundSchedules = { name: string; state: 'unbound' | 'elsewhere' | 'unavailable' }
  | { name: string; state: 'ready'; schedules: AppBoundSchedule[] };

export const SCHEDULE_OPERATIONS = ['register', 'update', 'pause', 'resume', 'remove'] as const;
export type AppScheduleOperation = (typeof SCHEDULE_OPERATIONS)[number];

/**
 * What one `operationId` came to, kept by the host: the same id asked again answers this, never a second change.
 * `applied`: done (`revision` the schedule's after it; null once removed). `conflict`: the schedule changed since the
 * revision named (`revision` the current one): read again and decide with a new operation id. `missing`: no such
 * schedule of this agent's. For the assistant living elsewhere, the panel's own states of an accepted change: `pending`
 * until its home applies it (the same id asked again tells where it is now), `failed` when the home could not,
 * `superseded` when a later change to the schedule replaced it first.
 */
export type AppScheduleReceipt = { name: string; operationId: string; op: AppScheduleOperation; at: string } & (
  | { status: 'applied' | 'pending' | 'failed' | 'superseded'; scheduleId: string; revision: string | null }
  | { status: 'conflict'; scheduleId: string; revision: string }
  | { status: 'missing'; scheduleId: string }
);

const name = z.string().regex(BINDING_NAME);
/** The caller's own idempotency key: a UUID or any id of its making, never reused for another change. */
const operationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const scheduleId = z.string().regex(/^schedule:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const revision = z.string().min(1).max(64);
const title = z.string().trim().min(1).max(200);
const when = { at: z.string().max(64).optional(), cron: z.string().max(128).optional(), tz: z.string().max(64).optional() };
const targeted = <T extends 'pause' | 'resume' | 'remove'>(op: T) => z.strictObject({ name, operationId, op: z.literal(op), scheduleId, revision });

/**
 * A change the App asks for. Strict: an owner, agent, session or chat it names is refused before anything is asked —
 * the agent is the one the binding's conversation is with, the account the signed-in one.
 */
export const scheduleControlSchema = z.discriminatedUnion('op', [
  z.strictObject({ name, operationId, op: z.literal('register'), title: title.optional(), prompt: z.string().trim().min(1).max(20_000), ...when }),
  z.strictObject({ name, operationId, op: z.literal('update'), scheduleId, revision, title: title.optional(), ...when }),
  targeted('pause'),
  targeted('resume'),
  targeted('remove'),
]);
export type AppScheduleControl = z.infer<typeof scheduleControlSchema>;
