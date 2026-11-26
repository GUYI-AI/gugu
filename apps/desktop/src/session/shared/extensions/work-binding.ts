import { z } from 'zod';
import { AGENT_STATUSES, AGENT_STATUS_DETAILS } from '@gugu/core/shared/agentStatus';

/**
 * A row's handle: opaque, made by the host for this App, this account and this choice of conversation — it means nothing to
 * another App, after the person chooses again, or after gugu restarts (read the list again then).
 */
export const WORK_HANDLE = /^w[A-Za-z0-9_-]{22}$/;
export const WORK_TITLE_MAX = 500;
const ISO_TIME = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), 'an ISO time');

/**
 * A task agent's state as the row's indicator draws it (`AgentStatusIndicator`): its base state and the detail that only
 * changes how it is drawn. The task's own outcome is folded in as the built-in list folds it (`assistantWorkStatus`):
 * completed is idle/done, failed is error, cancelled is none.
 */
export const appWorkStatusSchema = z.strictObject({
  status: z.enum(AGENT_STATUSES),
  detail: z.enum(AGENT_STATUS_DETAILS).nullable(),
});
export type AppWorkStatus = z.infer<typeof appWorkStatusSchema>;

/**
 * One row of the list, and nothing the built-in row (assistant-tasks.tsx) does not draw:
 * - `title`: the task's title; `naming`: true while the host would show "naming…" in its place (a new agent's default name);
 * - `status`: the indicator (null: none); `unseen`: the dot shown when it is idle and has news;
 * - `updatedAt`: when it last moved (ISO) — what the list sorts by and groups into days;
 * - `handle`: the row, for `openWork`.
 */
export type AppWorkItem = {
  handle: string;
  title: string;
  naming: boolean;
  status: AppWorkStatus | null;
  unseen: boolean;
  updatedAt: string;
};
export const APP_WORK_ITEM_FIELDS = ['handle', 'title', 'naming', 'status', 'unseen', 'updatedAt'] as const satisfies readonly (keyof AppWorkItem)[];

/**
 * `gugu.bindings.work(name)` (46, `chat:work`), and what `onWorkChanged` hears:
 * - `ready`: the rows, newest first; `stale`: the last refresh failed, these are the last ones read (the host retries);
 * - `unavailable`: it cannot be told now (not read yet, the read failed with nothing to show, the assistant not verifiable) —
 *   `onWorkChanged` says when it can;
 * - `unbound`: no conversation chosen.
 * `open`: the row whose conversation the host draws in this App's panel now, or null. A conversation that is not the person's
 * chat with their own assistant is refused (`denied`), not answered.
 */
export type AppBindingWork =
  | { name: string; state: 'unbound' }
  | { name: string; state: 'unavailable'; open: string | null }
  | { name: string; state: 'ready'; items: AppWorkItem[]; stale: boolean; open: string | null };

/** The rows as the window read them, handed to main (host data: the ids stay in main and never reach an App). */
export const pushedWorkRowSchema = z.strictObject({
  workId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  title: z.string().min(1).max(WORK_TITLE_MAX),
  naming: z.boolean(),
  status: appWorkStatusSchema.nullable(),
  unseen: z.boolean(),
  updatedAt: ISO_TIME,
});
export type PushedWorkRow = z.infer<typeof pushedWorkRowSchema>;

/**
 * What the window last read of the account's work ledger (AppWorkLedgerHost), as the built-in list reads it: `none` (not
 * reading: no account, no assistant, no App asking), `loading`, `ready`, `stale` (a refresh failed, the last rows kept),
 * `failed` (failed with nothing to keep). Whose it is and which assistant's: host data, checked against main's own reading.
 */
export const pushedWorkLedgerSchema = z.strictObject({
  ownerId: z.string().uuid().nullable(),
  assistantId: z.string().min(1).max(200).nullable(),
  state: z.enum(['none', 'loading', 'ready', 'stale', 'failed']),
  rows: z.array(pushedWorkRowSchema).max(5000),
});
export type PushedWorkLedger = z.infer<typeof pushedWorkLedgerSchema>;
