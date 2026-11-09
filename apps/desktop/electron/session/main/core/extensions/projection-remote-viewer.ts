import { randomUUID } from 'node:crypto';
import type { DeviceRpcResponse } from '@gugu/core/cloud/deviceRpcProtocol';
import type { ProjectionHostPacket, ProjectionInputOutcome } from '@shared/extensions/projection-protocol';
import { ProjectionInputFailure } from './extension-projections';
import { PROJECTION_REMOTE_PACKET, PROJECTION_REMOTE_RPC, type ProjectionRemotePacketEvent } from './projection-remote-host';

/**
 * #1607 node 5, the person's side: a page here watches its App's projection on the machine its session is on, over this
 * computer's device connection to that machine (projection-remote-host.ts). The page sees the same packets as for a
 * projection on this computer.
 */
export type ProjectionRemoteCaller = {
  call(deviceId: string, type: string, payload: unknown, options: { timeoutMs: number }): Promise<DeviceRpcResponse<unknown>>;
};
let caller: ProjectionRemoteCaller | null = null;
/** Installed by the main process with its cross-machine requester; its events come back through `projectionRemoteEvent`. */
export function setProjectionRemoteCaller(next: ProjectionRemoteCaller | null): void { caller = next; }

const watches = new Map<string, { deviceId: string; deliver(packet: ProjectionHostPacket): void }>();

/** A push from another machine; false when it is not a projection's. */
export function projectionRemoteEvent(deviceId: string, payload: unknown): boolean {
  const event = payload as Partial<ProjectionRemotePacketEvent> | null;
  if (event?.type !== PROJECTION_REMOTE_PACKET || typeof event.watch !== 'string') return false;
  const watch = watches.get(event.watch);
  // Only the machine that was asked may speak for a watch.
  if (watch?.deviceId === deviceId && event.packet && typeof event.packet === 'object') watch.deliver(event.packet);
  return true;
}

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

async function ask(deviceId: string, type: string, payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!caller) throw coded('unavailable', 'This computer cannot reach your other computers yet');
  const reply = await caller.call(deviceId, type, payload, { timeoutMs });
  if (reply.error) throw coded(reply.error.code, reply.error.message);
  return (reply.result ?? {}) as Record<string, unknown>;
}

export async function watchRemoteProjection(
  deviceId: string,
  /** An App's projection in that session, or `{ session, page: true }`: that task's own browser page. */
  input: { app: string; version: string; session: string; source: string } | { session: string; page: true },
  deliver: (packet: ProjectionHostPacket) => void,
): Promise<{ receive(packet: unknown): Promise<void>; close(): void }> {
  const watch = randomUUID();
  let closed = false;
  // Registered before asking: the first picture can arrive before the answer.
  watches.set(watch, { deviceId, deliver: (packet) => { if (!closed) deliver(packet); } });
  try {
    await ask(deviceId, PROJECTION_REMOTE_RPC.watch, { watch, ...input }, 30_000);
  } catch (error) {
    watches.delete(watch);
    throw error;
  }
  return {
    async receive(packet) {
      if (closed) throw new Error('Projection viewer is closed');
      const result = await ask(deviceId, PROJECTION_REMOTE_RPC.send, { watch, packet }, 60_000);
      if (result.status === 'applied') return;
      const message = typeof result.message === 'string' ? result.message.slice(0, 1000) : 'Projection input failed';
      throw new ProjectionInputFailure(message, result.uncertain === true, result.outcome as ProjectionInputOutcome | undefined);
    },
    close() {
      if (closed) return;
      closed = true;
      watches.delete(watch);
      void ask(deviceId, PROJECTION_REMOTE_RPC.unwatch, { watch }, 10_000).catch(() => undefined);
    },
  };
}
