// session-life 的唯一投影(LifeView)在渲染层的镜像 —— 会话所在那台机器的宿主每次转移后经 `sessionLifeViewChannel`
// 报来,第一次读某条会话时先向那台机器要一份当前的。只按 version 取新的,❌ 不在这里推断任何状态。
import { observable, runInAction } from 'mobx';
import type { LifeView } from '@shared/core/sessions/session-life';
import { sessionLifeViewChannel } from '@shared/core/sessions/sessionEvents';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { machineClient, onMachineReconnected } from '@renderer/lib/machine-clients';
import { mobxReadable } from '@/lib/mobxReadable';
import type { Readable } from '@/lib/selectStore';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/**
 * One mirror for every reader (desktop pages, the phone's session page), keyed by machine and session: the host's
 * versions only compare within one machine and one link epoch. A machine whose link comes back starts a new epoch (its
 * host may have restarted and counts from 1 again): its views are dropped and read again where wanted.
 */
const views = observable.map<string, LifeView>();
/** A read that failed (no view to show): said by the reader, cleared by the next view. */
const failures = observable.map<string, string>();
const requested = new Set<string>();

/** How a machine is reached from here: the desktop's machine clients, or the phone's device RPC. */
export type LifeRoute = {
  /** The machine (`''` = this one). */
  key: string;
  read: (sessionId: string) => Promise<LifeView>;
  listen: (accept: (view: LifeView) => void) => () => void;
  /** The link to that machine closed (false) or opened again (true): a new epoch either way. */
  onLink?: (change: (open: boolean) => void) => () => void;
};
type MachineEntry = { readers: number; stop: () => void; epoch: number; connected: boolean; wants: Map<string, Set<() => boolean>> };
const machines = new Map<string, MachineEntry>();
const viewKey = (machine: string, sessionId: string) => `${machine}\u0000${sessionId}`;

function accept(machine: string, view: LifeView): void {
  if (machines.get(machine)?.connected === false) return;
  const key = viewKey(machine, view.sessionId);
  const current = views.get(key);
  if (current && current.version >= view.version) return;
  runInAction(() => { views.set(key, view); failures.delete(key); });
  // A first snapshot may contain an old reload result. Only a new completion gets a transient notice.
  if (current && view.kind === 'ready' && view.nativeSession && current.nativeSession !== view.nativeSession) {
    toast({ title: translateSessionMessage(view.nativeSession === 'preserved' ? 'chat.reloadPreserved' : 'chat.reloadReplaced'), tier: 'info' });
  }
}

/** Forget a machine's views: nothing in this epoch may be compared with what comes next. */
function dropMachine(machine: string): void {
  const prefix = viewKey(machine, '');
  // A desktop page asks again for what it shows (`sessionLifeView` reads a key it has not asked for in this epoch).
  for (const key of [...requested]) if (key.startsWith(prefix)) requested.delete(key);
  runInAction(() => {
    for (const key of [...views.keys()]) if (key.startsWith(prefix)) views.delete(key);
    for (const key of [...failures.keys()]) if (key.startsWith(prefix)) failures.delete(key);
  });
}

function newEpoch(route: LifeRoute, entry: MachineEntry, open: boolean): void {
  entry.epoch += 1;
  entry.connected = open;
  dropMachine(route.key);
  if (open) for (const [sessionId, wants] of entry.wants) if ([...wants].some((want) => want())) void readLifeVia(route, sessionId).catch(() => undefined);
}

/**
 * Follow a machine's lifecycle events (and its link) while anyone reads it; `wanted` says whether a session must be
 * read again when the link comes back. Subscribed before any read (a push that beats the read is not lost).
 */
export function watchLife(route: LifeRoute, sessionId: string, wanted: () => boolean): () => void {
  let entry = machines.get(route.key);
  if (!entry) {
    const created: MachineEntry = { readers: 0, stop: () => undefined, epoch: 0, connected: true, wants: new Map() };
    const stopEvents = route.listen((view) => accept(route.key, view));
    const stopLink = route.onLink?.((open) => newEpoch(route, created, open)) ?? (() => undefined);
    created.stop = () => { stopEvents(); stopLink(); };
    machines.set(route.key, created);
    entry = created;
  }
  const active = entry;
  active.readers += 1;
  const wants = active.wants.get(sessionId) ?? new Set();
  active.wants.set(sessionId, wants.add(wanted));
  return () => {
    wants.delete(wanted);
    if (!wants.size) active.wants.delete(sessionId);
    // Nobody follows that machine's pushes any more: what is kept could go stale unnoticed, so it goes too.
    if (--active.readers === 0) { active.stop(); machines.delete(route.key); dropMachine(route.key); }
  };
}

/** Read the host's current view through this route; a failure in this epoch is said next to the view mirrored so far (❌ dropped). */
export async function readLifeVia(route: LifeRoute, sessionId: string): Promise<LifeView> {
  const epoch = machines.get(route.key)?.epoch;
  const key = viewKey(route.key, sessionId);
  try {
    const view = await route.read(sessionId);
    if (machines.get(route.key)?.epoch === epoch) accept(route.key, view);
    return views.get(key) ?? view;
  } catch (error) {
    if (machines.get(route.key)?.epoch === epoch) runInAction(() => { failures.set(key, error instanceof Error ? error.message : String(error)); });
    throw error;
  }
}

/** The view this route's machine has given for a session (a one-moment look, outside rendering). */
export function sessionLifeViewOf(route: LifeRoute, sessionId: string): LifeView | null {
  return views.get(viewKey(route.key, sessionId)) ?? null;
}

/** A session's view and read failure through this route, for `useSelect` (the MobX adapter). */
export function lifeReadable(route: LifeRoute, sessionId: string): Readable<{ view: LifeView | null; error: string | null }> {
  const key = viewKey(route.key, sessionId);
  return mobxReadable(() => ({ view: views.get(key) ?? null, error: failures.get(key) ?? null }));
}

/** The desktop's route to the machine a session lives on (its reconnect is a new epoch). */
function desktopRoute(machine: string | null): LifeRoute {
  return {
    key: machine ?? '',
    read: (sessionId) => rpcOn(machine).sessions.lifeView(sessionId),
    listen: (deliver) => onMachineEvent(machine, sessionLifeViewChannel, deliver),
    ...(machine ? { onLink: (change: (open: boolean) => void) => onMachineReconnected(machine, () => change(true)) } : {}),
  };
}

/** False while that machine has no bridge yet: its page already says the link is down, and the next ask listens. */
function listenOn(machine: string | null): boolean {
  if (machines.has(machine ?? '')) return true;
  if (machine && !machineClient(machine)) return false;
  // The desktop's pages follow a machine for the whole run (a held reader).
  watchLife(desktopRoute(machine), '', () => false);
  return true;
}

/** The session's lifecycle projection, or null until its host has answered the first read. */
export function sessionLifeView(sessionId: string): LifeView | null {
  const machine = machineRegistry.machineOf(sessionId);
  const key = viewKey(machine ?? '', sessionId);
  if (!listenOn(machine)) return views.get(key) ?? null;
  if (!requested.has(key)) {
    requested.add(key);
    void readLifeVia(desktopRoute(machine), sessionId).catch((error: unknown) => {
      requested.delete(key);
      throw error;
    });
  }
  return views.get(key) ?? null;
}

/** Read the host's current view (also when this page already mirrors it): the newest version this page knows. */
export async function readSessionLife(sessionId: string): Promise<LifeView> {
  const machine = machineRegistry.machineOf(sessionId);
  listenOn(machine);
  return readLifeVia(desktopRoute(machine), sessionId);
}

/** The person stopped this session (also mid-start): its host's session-life tears it down and holds it. */
export function stopSessionLife(sessionId: string): Promise<void> {
  return rpcOn(machineRegistry.machineOf(sessionId)).sessions.lifeStop(sessionId);
}

/** The person discards their own message they stopped before it went. */
export function discardSessionLifeRow(sessionId: string, messageId: string): Promise<void> {
  return rpcOn(machineRegistry.machineOf(sessionId)).sessions.lifeDiscard(sessionId, messageId);
}

/** Resend one host-owned unknown input only after an explicit click. */
export function retryUnknownSessionInput(sessionId: string, messageId: string): Promise<void> {
  return rpcOn(machineRegistry.machineOf(sessionId)).sessions.lifeRetryUnknown(sessionId, messageId);
}

/** The person opened or retried this session: its host's session-life starts it (a page never starts a runtime). */
export function startSessionLife(sessionId: string): Promise<void> {
  return rpcOn(machineRegistry.machineOf(sessionId)).sessions.lifeStart(sessionId);
}

/** A side chat's page opens its fork entry in the source session's host (idempotent for the same parent and source). */
export function forkSessionLife(fork: { forkId: string; parentId: string; forkFromProviderSessionId: string }): Promise<void> {
  return rpcOn(machineRegistry.machineOf(fork.forkId)).sessions.lifeFork(fork);
}

/** The page closed this side chat: its host's session-life ends the fork entry. */
export function endSessionLife(forkId: string): Promise<void> {
  return rpcOn(machineRegistry.machineOf(forkId)).sessions.lifeEnd(forkId);
}
