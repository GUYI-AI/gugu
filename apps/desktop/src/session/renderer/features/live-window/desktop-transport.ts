import { events, rpc } from '@renderer/lib/ipc';
import { liveWindowPacketChannel, liveWindowPageStateChannel, liveWindowSourcesChannel } from '@shared/events/liveWindowEvents';
import type { LiveWindowTransport } from './transport';
import { liveWindowDescriptors, viewerOnly } from './transport';
import { deviceLiveWindowTransport } from './device-transport';
import { rendererLogger } from '@/lib/log';

const log = rendererLogger('live-window/desktop');

export function desktopLiveWindowTransport(deviceId: string | null): LiveWindowTransport {
  if (deviceId) return deviceLiveWindowTransport(deviceId);
  return {
    list: async sessionId => liveWindowDescriptors(await rpc.extensions.liveWindowSources({ sessionId }), sessionId),
    async observe(sessionId, changed) {
      const watchId = crypto.randomUUID();
      const off = events.on(liveWindowSourcesChannel, event => { if (event.watchId === watchId && event.sessionId === sessionId) changed(); });
      try { await rpc.extensions.observeLiveWindowSources({ watchId, sessionId }); }
      catch (error) { off(); throw error; }
      return () => { off(); void rpc.extensions.unobserveLiveWindowSources(watchId).catch(error => log.warn({ error }, 'Could not release live picture metadata watch')); };
    },
    picture(source, page) {
      let current: string | null = null;
      return {
        projection: {
          ...viewerOnly,
          watch: async ({ watchId }) => {
            current = watchId;
            await rpc.extensions.watchLiveWindow({ watchId, sessionId: source.sessionId, sourceId: source.id });
          },
          unwatch: async ({ watchId }) => { if (current === watchId) current = null; await rpc.extensions.unwatchLiveWindow(watchId); },
          send: ({ watchId, packet }) => rpc.extensions.sendLiveWindow({ watchId, packet }),
        },
        onProjection(handler) {
          const off = events.on(liveWindowPacketChannel, event => { if (event.watchId === current) handler(event.watchId, event.packet); });
          const offPage = events.on(liveWindowPageStateChannel, event => { if (event.watchId === current) page(event.state); });
          return () => { off(); offPage(); };
        },
      };
    },
  };
}
