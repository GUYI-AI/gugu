import { unwrapPayload } from '@gugu/core/cloud/payload';
import { callDeviceRpc, subscribeDeviceRpcEvents } from '@/lib/deviceRpc';
import { rendererLogger } from '@/lib/log';
import type { ProjectionHostPacket, ProjectionInputOutcome } from '@shared/extensions/projection-protocol';
import { PROJECTION_REMOTE_RPC, PROJECTION_REMOTE_PACKET, PROJECTION_REMOTE_PAGE_STATE } from '@shared/extensions/projection-remote-rpc';
import { LIVE_WINDOW_SOURCES_CHANGED } from '@shared/extensions/live-window-protocol';
import type { LiveWindowTransport } from './transport';
import { liveWindowDescriptors, viewerOnly } from './transport';

const log = rendererLogger('live-window/device');

/** Phone and desktop use the same account-authenticated device connection and projection watch. */
export function deviceLiveWindowTransport(deviceId: string): LiveWindowTransport {
  const ask = async (type: string, payload: unknown) => {
    const response = await callDeviceRpc<Record<string, unknown>>(deviceId, type, payload, { timeoutMs: 30_000 });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result ?? {};
  };
  return {
    list: async sessionId => liveWindowDescriptors((await ask(PROJECTION_REMOTE_RPC.sources, { session: sessionId })).sources, sessionId),
    async observe(sessionId, changed) {
      const watch = crypto.randomUUID();
      let closed = false;
      const join = () => ask(PROJECTION_REMOTE_RPC.observeSources, { watch, session: sessionId });
      const off = subscribeDeviceRpcEvents(deviceId, payload => {
        const event = unwrapPayload(payload) as { type?: unknown; watch?: unknown; session?: unknown };
        if (!closed && event.type === LIVE_WINDOW_SOURCES_CHANGED && event.watch === watch && event.session === sessionId) changed();
      }, {
        onChannelSwitching: () => ({ type: PROJECTION_REMOTE_RPC.unobserveSources, payload: { watch } }),
        onChannelResubscribed: () => {
          if (!closed) void join().then(() => { if (!closed) changed(); }, error => log.warn({ error }, 'Could not rejoin live picture source metadata'));
        },
      });
      try { await join(); }
      catch (error) { closed = true; off(); throw error; }
      return () => { closed = true; off(); void ask(PROJECTION_REMOTE_RPC.unobserveSources, { watch }).catch(error => log.warn({ error }, 'Could not release live picture metadata watch')); };
    },
    picture(source, page) {
      let watch: string | null = null, generation = '', switching = false;
      const body = source.type === 'task-page' ? { session: source.sessionId, page: true as const }
        : { session: source.sessionId, app: source.appId, version: source.appVersion, source: source.id };
      let legacy = false;
      const join = async (watchId: string, presentation?: 1) => {
        if (!presentation || legacy) return ask(PROJECTION_REMOTE_RPC.watch, { watch: watchId, ...body });
        try { return await ask(PROJECTION_REMOTE_RPC.watch, { watch: watchId, ...body, presentation }); }
        catch (error) {
          if ((error as { code?: string }).code !== 'invalid_payload') throw error;
          legacy = true;
          return ask(PROJECTION_REMOTE_RPC.watch, { watch: watchId, ...body });
        }
      };
      let presentation: 1 | undefined;
      return {
        projection: {
          ...viewerOnly,
          watch: async args => { watch = args.watchId; presentation = args.presentation; await join(args.watchId, presentation); },
          unwatch: async ({ watchId }) => { if (watch === watchId) watch = null; await ask(PROJECTION_REMOTE_RPC.unwatch, { watch: watchId }); },
          send: async ({ watchId, packet }) => await ask(PROJECTION_REMOTE_RPC.send, { watch: watchId, packet }) as ProjectionInputOutcome,
        },
        onProjection: handler => subscribeDeviceRpcEvents(deviceId, payload => {
          const event = unwrapPayload(payload) as { type?: unknown; watch?: unknown; packet?: ProjectionHostPacket; state?: Parameters<typeof page>[0] };
          if (!watch || event.watch !== watch) return;
          if (event.type === PROJECTION_REMOTE_PACKET && event.packet) { generation = event.packet.generation; handler(watch, event.packet); }
          if (event.type === PROJECTION_REMOTE_PAGE_STATE && event.state) page(event.state);
        }, {
          onChannelSwitching: () => { switching = true; return watch ? { type: PROJECTION_REMOTE_RPC.unwatch, payload: { watch } } : undefined; },
          onChannelResubscribed: rejoin => {
            if ((!rejoin && !switching) || !watch) return;
            switching = false; const current = watch;
            void join(current, presentation).catch(error => {
              log.warn({ error }, 'Could not rejoin a live picture');
              if (watch === current) handler(current, { type: 'state', generation, state: 'closed', reason: 'The live picture connection ended' });
            });
          },
        }),
      };
    },
  };
}
