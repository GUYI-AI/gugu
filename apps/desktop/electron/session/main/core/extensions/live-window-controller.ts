import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { liveWindowPacketChannel, liveWindowPageStateChannel, liveWindowSourcesChannel } from '@shared/events/liveWindowEvents';
import { PROJECTION_NOT_SENT, PROJECTION_UNCONFIRMED, type ProjectionHostPacket, type ProjectionInputOutcome } from '@shared/extensions/projection-protocol';
import type { TaskPageState } from '@shared/browser-task-page';
import { readLiveWindowSources } from './live-window-sources';
import { observeLiveWindowSources } from './live-window-source-changes';
import { admitRemoteProjection } from './projection-remote-admit';
import { connectTaskPageScreen } from '../browser/task-page-screen';
import { extensionTaskPages, taskPageForScreen } from './task-page-host';
import { ProjectionInputFailure } from './extension-projections';

type Viewer = { receive(packet: unknown): Promise<void>; close(): void };
type Watch = { pending: Promise<Viewer>; closed: boolean; off(): void };
const watches = new Map<string, Watch>(), lists = new Map<string, () => void>();
function watchId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('A live picture watch needs an id');
}
function unwatch(id: string): { success: true } {
  const current = watches.get(id);
  if (current) {
    watches.delete(id); current.closed = true; current.off();
    void current.pending.then(viewer => viewer.close(), () => undefined);
  }
  return { success: true };
}

/** Trusted renderer presentation only. No App execution, capture driver or new picture transport. */
export const liveWindowController = {
  liveWindowSources: ({ sessionId }: { sessionId: string }) => readLiveWindowSources(sessionId),
  async observeLiveWindowSources(args: { watchId: string; sessionId: string }) {
    watchId(args.watchId);
    await readLiveWindowSources(args.sessionId);
    lists.get(args.watchId)?.();
    const off = observeLiveWindowSources(args.sessionId, () => events.emit(liveWindowSourcesChannel, args));
    lists.set(args.watchId, off);
    return { success: true };
  },
  unobserveLiveWindowSources(id: string) { lists.get(id)?.(); lists.delete(id); return { success: true }; },
  async watchLiveWindow(args: { watchId: string; sessionId: string; sourceId: string }) {
    watchId(args.watchId);
    unwatch(args.watchId);
    const entry: Watch = { closed: false, off: () => {}, pending: Promise.resolve(null as unknown as Viewer) };
    watches.set(args.watchId, entry);
    const packet = (packet: ProjectionHostPacket) => {
      if (!entry.closed && watches.get(args.watchId) === entry) events.emit(liveWindowPacketChannel, { watchId: args.watchId, packet });
    };
    const state = (state: TaskPageState) => {
      if (!entry.closed && watches.get(args.watchId) === entry) events.emit(liveWindowPageStateChannel, { watchId: args.watchId, state });
    };
    entry.pending = (async () => {
      const descriptors = await readLiveWindowSources(args.sessionId);
      const source = descriptors.find(source => source.id === args.sourceId);
      if (!source || entry.closed) throw new Error('This live picture is not in the current session');
      if (source.type === 'app-projection') {
        return admitRemoteProjection({ app: source.appId, version: source.appVersion, session: source.sessionId, source: source.id }, packet);
      }
      const lease = extensionTaskPages.describeSession(args.sessionId).find(lease => lease.id === source.id);
      if (!lease) throw new Error('The task page lease ended');
      const close = () => unwatch(args.watchId);
      lease.signal.addEventListener('abort', close, { once: true });
      entry.off = () => lease.signal.removeEventListener('abort', close);
      lease.signal.throwIfAborted();
      return connectTaskPageScreen(args.sessionId, () => taskPageForScreen(args.sessionId), packet, state);
    })();
    try { await entry.pending; }
    catch (error) { if (watches.get(args.watchId) === entry) unwatch(args.watchId); throw error; }
    if (entry.closed) return { success: false };
    return { success: true };
  },
  async sendLiveWindow(args: { watchId: string; packet: unknown }): Promise<ProjectionInputOutcome> {
    const entry = watches.get(args.watchId);
    if (!entry || entry.closed) throw new Error('This live picture is not watched');
    try { await (await entry.pending).receive(args.packet); return { status: 'applied' }; }
    catch (error) {
      if ((args.packet as { type?: unknown } | null)?.type !== 'input') throw error;
      if (error instanceof ProjectionInputFailure && error.outcome) return error.outcome;
      log.warn('Live picture input failed', { error: String(error) });
      return error instanceof ProjectionInputFailure && error.uncertain
        ? { status: 'unknown', reason: PROJECTION_UNCONFIRMED } : { status: 'rejected', reason: PROJECTION_NOT_SENT };
    }
  },
  unwatchLiveWindow: unwatch,
};
