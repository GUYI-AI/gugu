import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';
import { ExtensionProjections, type ProjectionSource } from './extension-projections';
import { revokeExtensionProgramAccess } from './extension-program-access';
import { createProjectionRemoteHost, PROJECTION_REMOTE_VIEWERS, type ProjectionRemoteSources } from './projection-remote-host';
import { projectionRemoteEvent, setProjectionRemoteCaller, watchRemoteProjection } from './projection-remote-viewer';

const owner = { extensionId: 'browser-use', sessionId: 'task-on-d22' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Two computers in one process: the person's side (projection-remote-viewer) asks the session's machine
 * (projection-remote-host) through a fake device connection that, like the real one, answers calls and pushes events to
 * the asker only.
 */
function twoComputers(overrides: Partial<ProjectionSource> = {}, admit?: (input: Parameters<ProjectionRemoteSources['connect']>[0]) => void) {
  const resources = new ExtensionProjections(() => {});
  const source: ProjectionSource = { input: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), refresh: vi.fn(), close: vi.fn(), ...overrides };
  const resource = resources.open(owner, source);
  const host = createProjectionRemoteHost(() => ({
    connect: async (input, send) => {
      admit?.(input);
      const viewer = resources.connect({ extensionId: input.app, sessionId: input.session }, input.source, { transport: 'device', send, onClose: () => () => {} });
      return { receive: viewer.receive, close: viewer.close };
    },
    page: async () => { throw Object.assign(new Error('This task has no browser page'), { code: 'not-found' }); },
  }));
  const detached = new Set<() => void>();
  const pushed: unknown[] = [];
  setProjectionRemoteCaller({
    call: async (deviceId, type, payload) => {
      expect(deviceId).toBe('device-d22');
      const handler = host.handlers[type]!;
      // The wire is JSON both ways.
      return JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(payload)), {
        request: {} as never, env: {},
        publishEvent: (event: unknown) => { pushed.push(event); projectionRemoteEvent('device-d22', JSON.parse(JSON.stringify(event))); },
        asker: { onDetached: (listener: () => void) => { detached.add(listener); return () => detached.delete(listener); } } as never,
      })));
    },
  });
  const publish = (sequence: number) => resource.publish({ sequence, width: 1280, height: 720, mime: 'image/jpeg', data: 'aGVsbG8=' });
  return { resources, resource, source, host, publish, pushed, detach: () => { for (const listener of [...detached]) listener(); } };
}

async function watch(packets: ProjectionHostPacket[], id: string, version = '0.4.0') {
  return watchRemoteProjection('device-d22', { app: owner.extensionId, version, session: owner.sessionId, source: id }, packet => packets.push(packet));
}

afterEach(() => {
  setProjectionRemoteCaller(null);
  revokeExtensionProgramAccess(owner.extensionId);
});

describe('an App projection watched from another computer (#1607 node 5)', () => {
  it('pictures come back one at a time; acknowledged input reaches the source on that machine', async () => {
    const c = twoComputers();
    const packets: ProjectionHostPacket[] = [];
    const viewer = await watch(packets, c.resource.id);
    c.publish(1);
    c.publish(2);
    await tick();
    const generation = packets[0]!.type === 'state' ? packets[0]!.generation : '';
    // One picture in flight: the second waits for the first to be shown.
    expect(packets.filter(p => p.type === 'frame').map(p => p.type === 'frame' && p.frame.sequence)).toEqual([1]);
    await viewer.receive({ type: 'ack', generation, frame: 1 });
    await tick();
    expect(packets.filter(p => p.type === 'frame').map(p => p.type === 'frame' && p.frame.sequence)).toEqual([1, 2]);
    await viewer.receive({ type: 'ack', generation, frame: 2 });
    await viewer.receive({ type: 'input', generation, frame: 2, sequence: 1, input: { kind: 'pointer', action: 'down', x: 0.5, y: 0.25, button: 'left' } });
    expect(c.source.input).toHaveBeenCalledWith({ kind: 'pointer', action: 'down', x: 0.5, y: 0.25, button: 'left' }, expect.objectContaining({ frame: expect.objectContaining({ sequence: 2 }) }));
    viewer.close();
    await tick();
    expect(c.host.size()).toBe(0);
    // Closing released what this viewer held.
    expect(c.source.disconnect).toHaveBeenCalledWith(generation);
  });

  it('a refusal on that machine comes back as the same outcome the page reads locally', async () => {
    const c = twoComputers({ input: async () => ({ status: 'rejected', reason: 'The page went away' }) });
    const packets: ProjectionHostPacket[] = [];
    const viewer = await watch(packets, c.resource.id);
    c.publish(1);
    await tick();
    const generation = packets[0]!.type === 'state' ? packets[0]!.generation : '';
    await viewer.receive({ type: 'ack', generation, frame: 1 });
    const failed = await viewer.receive({ type: 'input', generation, frame: 1, sequence: 1, input: { kind: 'text', text: 'hi' } }).catch(error => error);
    expect(failed).toMatchObject({ message: 'The page went away', uncertain: false, outcome: { status: 'rejected', reason: 'The page went away' } });
  });

  it('only the asked machine speaks for a watch, and pushes of other kinds are not taken', async () => {
    const c = twoComputers();
    const packets: ProjectionHostPacket[] = [];
    await watch(packets, c.resource.id);
    await tick();
    const before = packets.length;
    const watchId = (c.pushed[0] as { watch: string }).watch;
    expect(projectionRemoteEvent('device-other', { type: 'appProjection.packet', watch: watchId, packet: { type: 'state', generation: 'x', state: 'closed' } })).toBe(true);
    expect(packets.length).toBe(before);
    expect(projectionRemoteEvent('device-d22', { type: 'deviceAction.result' })).toBe(false);
  });

  it('refusals: another version of the App, a source of another App or task, too many viewers', async () => {
    const c = twoComputers({}, input => {
      if (input.version !== '0.4.0') throw Object.assign(new Error('That computer has version 0.4.0 of this App'), { code: 'version-mismatch' });
    });
    await expect(watch([], c.resource.id, '0.3.0')).rejects.toMatchObject({ code: 'version-mismatch' });
    await expect(watchRemoteProjection('device-d22', { app: 'other-app', version: '0.4.0', session: owner.sessionId, source: c.resource.id }, () => {}))
      .rejects.toThrow('Projection is not in this App session');
    const viewers = [];
    for (let index = 0; index < PROJECTION_REMOTE_VIEWERS; index++) viewers.push(await watch([], c.resource.id));
    await expect(watch([], c.resource.id)).rejects.toMatchObject({ code: 'busy' });
    for (const viewer of viewers) viewer.close();
  });

  it('the asking connection going away ends its viewers there', async () => {
    const c = twoComputers();
    await watch([], c.resource.id);
    expect(c.host.size()).toBe(1);
    c.detach();
    await tick();
    expect(c.host.size()).toBe(0);
    expect(c.source.disconnect).toHaveBeenCalled();
  });

  it('a malformed request is refused before anything is opened', async () => {
    const c = twoComputers();
    const handler = c.host.handlers['appProjection.watch']!;
    expect(await handler({ watch: 'short', app: 'a', version: '1', session: 's', source: 'x' }, { request: {} as never, env: {}, publishEvent: () => undefined }))
      .toMatchObject({ error: { code: 'invalid_payload' } });
    expect(await handler({ watch: 'a'.repeat(32), app: 'a', version: '1', session: 's', source: 'x', extra: 1 }, { request: {} as never, env: {}, publishEvent: () => undefined }))
      .toMatchObject({ error: { code: 'invalid_payload' } });
    expect(c.host.size()).toBe(0);
  });
});
