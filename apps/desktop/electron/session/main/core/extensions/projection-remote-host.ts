import type { DeviceRpcHandlerContext, DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';
import { log } from '@main/lib/logger';

/**
 * #1607 node 5 — an App's projection, watched from another of the person's computers.
 *
 * The App's page is on the computer the person looks at; its program and the projection it publishes are on the machine
 * the session is on ("页面跟着人，程序跟着数据"). The person's computer asks this machine over the device connection both
 * already share (Gugu cloud or SSH; the trust boundary is the account, as for `agentSession.app_call`): watch a projection,
 * send it the viewer's packets (frame acknowledgements and input), stop watching. Pictures come back as events to that
 * asker only. The projection's own one-picture-in-flight acknowledgement paces them: a slow link lowers the frame rate,
 * it never builds a backlog. Nothing here knows what the picture shows or how the App made it.
 */
export const PROJECTION_REMOTE_RPC = {
  watch: 'appProjection.watch',
  send: 'appProjection.send',
  unwatch: 'appProjection.unwatch',
} as const;
export const PROJECTION_REMOTE_PACKET = 'appProjection.packet';
/** Viewers held for other computers at once (each is one page watching one projection). */
export const PROJECTION_REMOTE_VIEWERS = 32;

/** An App's projection in a session there, or (`page: true`) that task's own browser page, which is gugu's. */
export type ProjectionRemoteAppWatch = { app: string; version: string; session: string; source: string };
export type ProjectionRemoteWatch = { watch: string } & (ProjectionRemoteAppWatch | { session: string; page: true });
export type ProjectionRemotePacketEvent = { type: typeof PROJECTION_REMOTE_PACKET; watch: string; packet: ProjectionHostPacket };

type Viewer = { receive(packet: unknown): Promise<void>; close(): void };
export interface ProjectionRemoteSources {
  /** Admit a viewer for this App's projection in this session, on this machine; throws a coded refusal. */
  connect(input: ProjectionRemoteAppWatch, send: (packet: ProjectionHostPacket) => void): Promise<Viewer>;
  /** The task's own browser page on this machine. */
  page(session: string, send: (packet: ProjectionHostPacket) => void): Promise<Viewer>;
}

const ID = /^[A-Za-z0-9_-]{8,128}$/;
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const refuse = (code: string, message: string) => ({ error: { code, message } });

export function createProjectionRemoteHost(sources: () => ProjectionRemoteSources) {
  const viewers = new Map<string, { viewer: Viewer; stop(): void }>();
  const end = (watch: string) => {
    const entry = viewers.get(watch);
    if (!entry) return;
    viewers.delete(watch);
    entry.stop();
    entry.viewer.close();
  };

  const handlers: DeviceRpcHandlers = {
    [PROJECTION_REMOTE_RPC.watch]: async (payload, ctx: DeviceRpcHandlerContext) => {
      const body = (payload ?? {}) as Partial<Record<'watch' | 'session' | 'page' | keyof ProjectionRemoteAppWatch, unknown>>;
      const page = body.page === true;
      const keys = page ? ['watch', 'session', 'page'] : ['watch', 'app', 'version', 'session', 'source'];
      if (Object.keys(body).some(key => !keys.includes(key)) || !text(body.watch) || !ID.test(body.watch) || !text(body.session)
        || !page && (!text(body.app) || !text(body.version, 64) || !text(body.source))) {
        return refuse('invalid_payload', 'watch and session are required, with page, or with app, version and source');
      }
      const watch = body.watch;
      const session = body.session;
      end(watch);
      if (viewers.size >= PROJECTION_REMOTE_VIEWERS) return refuse('busy', 'Too many projections are watched from other computers');
      let viewer: Viewer;
      try {
        const send = (packet: ProjectionHostPacket) => {
          // A picture that cannot be pushed ends this viewer; the page reconnects instead of waiting for an ACK that never comes.
          void Promise.resolve(ctx.publishEvent({ type: PROJECTION_REMOTE_PACKET, watch, packet } satisfies ProjectionRemotePacketEvent))
            .catch((error: unknown) => { log.warn('[projection-remote] push failed', { error: String(error) }); end(watch); });
          if (packet.type === 'state' && packet.state === 'closed') {
            const entry = viewers.get(watch);
            if (entry?.viewer === viewer) { viewers.delete(watch); entry.stop(); }
          }
        };
        viewer = page ? await sources().page(session, send)
          : await sources().connect({ app: body.app as string, version: body.version as string, session, source: body.source as string }, send);
      } catch (error) {
        const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'refused';
        return refuse(code, error instanceof Error ? error.message : String(error));
      }
      // The asker's connection went away: nobody is left to acknowledge or drive.
      const stop = ctx.asker?.onDetached(() => end(watch)) ?? (() => {});
      viewers.set(watch, { viewer, stop });
      return { result: { watching: true } };
    },
    [PROJECTION_REMOTE_RPC.send]: async (payload) => {
      const body = (payload ?? {}) as { watch?: unknown; packet?: unknown };
      if (Object.keys(body).some(key => !['watch', 'packet'].includes(key)) || !text(body.watch)) return refuse('invalid_payload', 'watch and packet are required');
      const entry = viewers.get(body.watch);
      if (!entry) return refuse('not_open', 'This projection is not watched');
      try {
        await entry.viewer.receive(body.packet);
        return { result: { status: 'applied' } };
      } catch (error) {
        // The bridge on the asking computer turns this into the page's applied / rejected / unknown, as it does locally.
        const failure = error as { uncertain?: unknown; outcome?: unknown };
        return { result: { status: 'failed', message: error instanceof Error ? error.message : String(error),
          uncertain: failure?.uncertain === true, ...(failure?.outcome ? { outcome: failure.outcome } : {}) } };
      }
    },
    [PROJECTION_REMOTE_RPC.unwatch]: (payload) => {
      const watch = (payload as { watch?: unknown } | null)?.watch;
      if (!text(watch)) return refuse('invalid_payload', 'watch is required');
      end(watch);
      return { result: { closed: true } };
    },
  };

  return {
    handlers,
    dispose: () => { for (const watch of [...viewers.keys()]) end(watch); },
    /** Test hook. */
    size: () => viewers.size,
  };
}
