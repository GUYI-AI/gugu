import { browserTaskPagePacketChannel, browserTaskPageStateChannel } from '@shared/events/browserEvents';
import type { TaskPageControl } from '@shared/browser-task-page';
import { PROJECTION_NOT_SENT, PROJECTION_UNCONFIRMED, type ProjectionInputOutcome } from '@shared/extensions/projection-protocol';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { ProjectionInputFailure } from '../extensions/extension-projections';
import { watchRemoteProjection } from '../extensions/projection-remote-viewer';

/**
 * #1607 node 5, this computer's side: a browser tab showing a task's page that lives on another of the person's
 * computers (a Gugu server's headless Chromium). The tab watches it over this computer's device connection to that
 * machine (projection-remote-host.ts → task-page-screen.ts there) and gets its packets as `browserTaskPagePacketChannel`.
 */
const watches = new Map<string, Promise<{ receive(packet: unknown): Promise<void>; control(control: TaskPageControl): Promise<void>; close(): void }>>();

export async function watchRemoteTaskPage(args: { watchId: string; deviceId: string; sessionId: string }): Promise<{ success: true }> {
  if (typeof args.watchId !== 'string' || !args.watchId || args.watchId.length > 128) throw new Error('A task page watch needs an id');
  // The picture's reset asks again with the same id (as for a projection on this computer): start that watch over.
  unwatchRemoteTaskPage(args.watchId);
  const watching = watchRemoteProjection(args.deviceId, { session: args.sessionId, page: true },
    (packet) => events.emit(browserTaskPagePacketChannel, { watchId: args.watchId, packet }),
    (state) => events.emit(browserTaskPageStateChannel, { watchId: args.watchId, state }));
  watches.set(args.watchId, watching);
  try { await watching; }
  catch (error) { if (watches.get(args.watchId) === watching) watches.delete(args.watchId); throw error; }
  return { success: true };
}

/** A frame shown (ack) or the person's input, with the same outcomes as a picture on this computer. */
export async function sendRemoteTaskPage(args: { watchId: string; packet: unknown }): Promise<ProjectionInputOutcome> {
  const watching = watches.get(args.watchId);
  if (!watching) throw new Error('This task page is not watched');
  const viewer = await watching;
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
export async function controlRemoteTaskPage(args: { watchId: string; control: TaskPageControl }): Promise<{ success: true }> {
  const watching = watches.get(args.watchId);
  if (!watching) throw new Error('This task page is not watched');
  await (await watching).control(args.control);
  return { success: true };
}

export function unwatchRemoteTaskPage(watchId: string): boolean {
  const watching = watches.get(watchId);
  if (!watching) return false;
  watches.delete(watchId);
  void watching.then((viewer) => viewer.close(), () => undefined);
  return true;
}
