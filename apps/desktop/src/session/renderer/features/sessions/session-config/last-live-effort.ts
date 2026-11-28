import { readInterface, writeInterface } from '@/lib/viewStateTable';

/**
 * #3973 The level each session last ran at, as its live session reported it, for the moments it is not live.
 *
 * The composer's model button names the level ("Opus 5.5 中"). A session not live (stopped, the app just reopened, the
 * seconds of a restart after a model switch) shows the level on its record, which holds a level only when one was picked
 * or armed at creation. A session without one (started on a model with no levels and switched later, or started by an
 * agent with no level) had none to show until it went live (owner 2026-11-26: 「不跑起来这个 thinking 水平就没有了」).
 * Its thread keeps its level across restarts (codex thread/resume hands it back), so the level it last ran at is the one
 * it comes back with. Kept for the most recent sessions on this device only; shown, never sent. A session that never ran
 * with a level here has nothing remembered: its first restart onto a model with levels shows none until it reports.
 */
const NAME = 'last-live-effort';
/** Most recent sessions kept: about what its own capped entry holds (view-state-models.ts). */
const LIMIT = 16;
type Remembered = Record<string, string>;

/** The level this session last ran at, if it is one of `levels` (the levels the menu offers now). */
export function lastLiveEffort(
  sessionId: string | null | undefined,
  levels: Readonly<Record<string, unknown>> | null | undefined,
): string | undefined {
  if (!sessionId || !levels) return undefined;
  const level = readInterface<Remembered>(NAME)?.[sessionId];
  return level && Object.hasOwn(levels, level) ? level : undefined;
}

/** This session's live session reported `level`. */
export function rememberLiveEffort(sessionId: string, level: string): void {
  const remembered: Remembered = { ...readInterface<Remembered>(NAME) };
  if (remembered[sessionId] === level) return;
  delete remembered[sessionId];
  remembered[sessionId] = level;
  writeInterface<Remembered>(NAME, Object.fromEntries(Object.entries(remembered).slice(-LIMIT)));
}

/**
 * gugu-dev#1579 (owner 2026-11-27 「B」) The level the person picked by hand in each session: picked in its composer, or
 * picked on the new-task box it was started from. Only this level follows a model switch; a level the app filled in
 * stays with its model. Same table and limit as the levels above; shown and carried, never sent by itself.
 */
const PICKED = 'picked-effort';

/** The level the person picked in this session, if any. */
export function pickedEffort(sessionId: string | null | undefined): string | undefined {
  return sessionId ? readInterface<Remembered>(PICKED)?.[sessionId] : undefined;
}

/** The person picked `level` in this session; null = they reset it (the app's level again). */
export function rememberPickedEffort(sessionId: string, level: string | null): void {
  const remembered: Remembered = { ...readInterface<Remembered>(PICKED) };
  if ((remembered[sessionId] ?? null) === level) return;
  delete remembered[sessionId];
  if (level) remembered[sessionId] = level;
  writeInterface<Remembered>(PICKED, Object.fromEntries(Object.entries(remembered).slice(-LIMIT)));
}
