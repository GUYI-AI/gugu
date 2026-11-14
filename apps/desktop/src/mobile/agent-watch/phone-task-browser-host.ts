import { unwrapPayload } from '@gugu/core/cloud/payload';
import { callDeviceRpc, subscribeDeviceRpcEvents } from '@/lib/deviceRpc';
import type { TaskPageControl, TaskPageControlResult, TaskPageState } from '@shared/browser-task-page';
import type { ProjectionHostPacket, ProjectionInputOutcome } from '@shared/extensions/projection-protocol';
import { PROJECTION_REMOTE_RPC, PROJECTION_REMOTE_PACKET, PROJECTION_REMOTE_PAGE_STATE } from '@shared/extensions/projection-remote-rpc';
import type { ProjectionHost } from '@/session/app-runtime/projection-source';

/** A person's phone watches the task's existing page through the same authenticated watch as another desktop. */
export function phoneTaskBrowserHost(deviceId: string, sessionId: string, page: (state: TaskPageState) => void) {
  let watch: string | null = null;
  let generation = '';
  let switching = false;
  const ask = async (type: string, payload: unknown) => {
    const response = await callDeviceRpc<Record<string, unknown>>(deviceId, type, payload, { timeoutMs: 30_000 });
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result ?? {};
  };
  const host: ProjectionHost = {
    projection: {
      watch: async ({ watchId }) => { watch = watchId; await ask(PROJECTION_REMOTE_RPC.watch, { watch: watchId, session: sessionId, page: true }); },
      unwatch: async ({ watchId }) => { if (watch === watchId) watch = null; await ask(PROJECTION_REMOTE_RPC.unwatch, { watch: watchId }); },
      send: async ({ watchId, packet }) => await ask(PROJECTION_REMOTE_RPC.send, { watch: watchId, packet }) as ProjectionInputOutcome,
      create: () => Promise.reject(new Error('The task page is watched here')),
      publish: () => Promise.reject(new Error('The task page is watched here')),
      close: async () => {}, closed: async () => {}, inputResult: async () => {},
    },
    onProjection: handler => subscribeDeviceRpcEvents(deviceId, payload => {
      const event = unwrapPayload(payload) as { type?: string; watch?: string; packet?: ProjectionHostPacket; state?: TaskPageState };
      if (!watch || event.watch !== watch) return;
      if (event.type === PROJECTION_REMOTE_PACKET && event.packet) { generation = event.packet.generation; handler(watch, event.packet); }
      if (event.type === PROJECTION_REMOTE_PAGE_STATE && event.state) page(event.state);
    }, {
      onChannelSwitching: () => { switching = true; return watch ? { type: PROJECTION_REMOTE_RPC.unwatch, payload: { watch } } : undefined; },
      onChannelResubscribed: rejoin => {
        if ((!rejoin && !switching) || !watch) return;
        switching = false; const current = watch;
        void ask(PROJECTION_REMOTE_RPC.watch, { watch: current, session: sessionId, page: true }).catch(error => {
          if (watch === current) handler(current, { type: 'state', generation, state: 'closed', reason: error instanceof Error ? error.message : String(error) });
        });
      },
    }),
  };
  return { host, async control(control: TaskPageControl): Promise<TaskPageControlResult> {
    if (!watch) throw new Error('The browser page is not watched');
    return (await ask(PROJECTION_REMOTE_RPC.control, { watch, control })).inspection as TaskPageControlResult;
  } };
}
