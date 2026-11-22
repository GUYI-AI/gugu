import { browserTaskPagePacketChannel, browserTaskPageStateChannel } from '@shared/events/browserEvents';
import type { TaskPageControl, TaskPageControlResult } from '@shared/browser-task-page';
import { PROJECTION_NOT_SENT, PROJECTION_UNCONFIRMED, type ProjectionInputOutcome } from '@shared/extensions/projection-protocol';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { ProjectionInputFailure } from '../extensions/extension-projections';
import { watchRemoteProjection } from '../extensions/projection-remote-viewer';
import type { StandaloneMenuPoint } from './standalone-context-menu';

/**
 * #1607 node 5, this computer's side: a browser tab showing a task's page that lives on another of the person's
 * computers (a Gugu server's headless Chromium). The tab watches it over this computer's device connection to that
 * machine (projection-remote-host.ts → task-page-screen.ts there) and gets its packets as `browserTaskPagePacketChannel`.
 */
type TaskPageViewer = Awaited<ReturnType<typeof watchRemoteProjection>> & {
  contextMenu?(sender: number, point: StandaloneMenuPoint, current: () => boolean): Promise<boolean>;
};
type Watch = { viewer: Promise<TaskPageViewer>; menuScope?: { binding: string } };
const watches = new Map<string, Watch>();

export async function watchRemoteTaskPage(args: { watchId: string; deviceId: string; sessionId: string }): Promise<{ success: true }> {
  return watchTaskPageConnection(args.watchId, () => watchRemoteProjection(args.deviceId, { session: args.sessionId, page: true, presentation: 1 },
    (packet) => events.emit(browserTaskPagePacketChannel, { watchId: args.watchId, packet }),
    (state) => events.emit(browserTaskPageStateChannel, { watchId: args.watchId, state })));
}

/** Local and remote task pages share the same acknowledged picture/input transport. */
export async function watchTaskPageConnection(watchId: string, connect: () => Promise<TaskPageViewer>, menuBinding?: string): Promise<{ success: true }> {
  if (typeof watchId !== 'string' || !watchId || watchId.length > 128) throw new Error('A task page watch needs an id');
  const previous = watches.get(watchId);
  // The menu may take focus and cause a reset. Keep it bound to the same tab and owner across that reset.
  const menuScope = menuBinding === undefined ? undefined
    : previous?.menuScope?.binding === menuBinding ? previous.menuScope : { binding: menuBinding };
  const viewer = (async () => {
    const old = await previous?.viewer.catch(() => undefined);
    await old?.close();
    return connect();
  })();
  const watching = { viewer, menuScope };
  watches.set(watchId, watching);
  try { await viewer; }
  catch (error) { if (watches.get(watchId) === watching) watches.delete(watchId); throw error; }
  return { success: true };
}

/** A frame shown (ack) or the person's input, with the same outcomes as a picture on this computer. */
export async function sendRemoteTaskPage(args: { watchId: string; packet: unknown }): Promise<ProjectionInputOutcome> {
  const watching = watches.get(args.watchId);
  if (!watching) throw new Error('This task page is not watched');
  const viewer = await watching.viewer;
  try {
    await viewer.receive(args.packet);
    return { status: 'applied' };
  } catch (error) {
    if ((args.packet as { type?: unknown } | null)?.type !== 'input') throw error;
    if (error instanceof ProjectionInputFailure && error.outcome) return error.outcome;
    log.warn('Remote task page input failed', { error: String(error) });
    return error instanceof ProjectionInputFailure && error.uncertain
      ? { status: 'unknown', reason: PROJECTION_UNCONFIRMED } : { status: 'rejected', reason: PROJECTION_NOT_SENT };
  }
}

/** The toolbar's buttons and address bar, and the tab's size, applied to the page there. */
export async function controlRemoteTaskPage(args: { watchId: string; control: TaskPageControl }): Promise<{ success: true; inspection?: Exclude<TaskPageControlResult, void> }> {
  const watching = watches.get(args.watchId);
  if (!watching) throw new Error('This task page is not watched');
  const inspection = await (await watching.viewer).control(args.control);
  return { success: true, ...(inspection ? { inspection } : {}) };
}

export async function showWatchedBrowserContextMenu(sender: number, args: { watchId: string; point: StandaloneMenuPoint }): Promise<boolean> {
  const watching = watches.get(args.watchId);
  if (!watching) return false;
  const current = () => {
    const active = watches.get(args.watchId);
    return active === watching || (watching.menuScope !== undefined && active?.menuScope === watching.menuScope);
  };
  const viewer = await watching.viewer;
  return watches.get(args.watchId) === watching && (await viewer.contextMenu?.(sender, args.point, current) ?? false);
}

export function unwatchRemoteTaskPage(watchId: string): boolean {
  const watching = watches.get(watchId);
  if (!watching) return false;
  watches.delete(watchId);
  void watching.viewer.then(viewer => viewer.close()).catch(() => undefined);
  return true;
}
