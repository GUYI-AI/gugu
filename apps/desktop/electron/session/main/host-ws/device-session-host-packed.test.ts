// Both ends of a session host window over a device link, joined in one process: what the machine packs
// (device-session-host `packAnswer`) is what the reader unpacks (remoteSessionHost `unpackFrame`).
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn(), subscribeDeviceRpcEvents: vi.fn() }));
import type { DeviceRpcHandlerContext } from '@gugu/core/cloud/deviceRpcResponder';
import { openRemoteSessionHostPipe, type DeviceRpcDeps } from '@/lib/remoteSessionHost';
import { decodeHostWsMessage, encodeHostWsMessage } from '@shared/lib/ipc/host-ws-protocol';
import { createSessionHostDeviceRpcHandlers } from './device-session-host';
import { FrameSessionHost } from './frame-host';

const page = { nextCursor: 41, turns: Array.from({ length: 60 }, (_, seq) => ({ id: `s:turn:s${seq}`, seq, startedAt: 1_000 * seq,
  items: [{ kind: 'message', id: `s:turn:s${seq}:message:r`, role: 'assistant', text: `第 ${seq} 轮:两项没做完,都不大。Two items left, both small. `.repeat(8) }] })) };

/** A window between a machine and a reader; `asks` is what the reader says when it opens. */
async function linked(reader: 'current' | 'older') {
  const frameHost = new FrameSessionHost();
  frameHost.ipcMain.handle('sessions.getStoredHistory', () => page);
  const { handlers, dispose } = createSessionHostDeviceRpcHandlers({ host: () => frameHost });
  const onLine: string[] = [];
  let listener: ((payload: unknown) => void) | null = null;
  const ctx = { request: { user_id: 'owner' }, publishEvent: (event: unknown) => { onLine.push(JSON.stringify(event)); queueMicrotask(() => listener?.(JSON.parse(JSON.stringify(event)))); } } as unknown as DeviceRpcHandlerContext;
  const deps: DeviceRpcDeps = {
    call: (async (_device: string, type: string, payload: Record<string, unknown>) => {
      // A reader from before packed frames says nothing about them.
      const said = type === 'taskhost.open' && reader === 'older' ? { client: payload.client, protocol: payload.protocol } : payload;
      return await handlers[type]!(JSON.parse(JSON.stringify(said)), ctx);
    }) as never,
    subscribe: ((_device: string, cb: (payload: unknown) => void) => { listener = cb; return () => { listener = null; }; }) as never,
    newClientId: () => 'client00000001', isSshMachine: () => false, requestUpgrade: async () => true,
  };
  const answers: unknown[] = [];
  const pipe = await openRemoteSessionHostPipe('dev', deps)({ onClose: () => undefined,
    onFrame: (frame) => { const message = decodeHostWsMessage(frame); if (message?.t === 'result') answers.push(message); } });
  pipe.send(encodeHostWsMessage({ t: 'invoke', id: 1, channel: 'sessions.getStoredHistory', args: [{ sessionId: 's', before: 100, lean: 'folded' }] }));
  await vi.waitFor(() => expect(answers).toHaveLength(1));
  pipe.close(); dispose();
  return { answer: answers[0], onLine: onLine.filter(line => !line.includes('"hello"')).join('') };
}

describe('a page of history asked for over a device link', () => {
  it('arrives as it was read, and travels packed to a reader that reads packed frames', async () => {
    const plain = await linked('older'), packed = await linked('current');
    expect(packed.answer).toEqual({ t: 'result', id: 1, ok: true, value: page });
    expect(plain.answer).toEqual(packed.answer);
    expect(plain.onLine).toContain('{\\"t\\":\\"result\\"');
    expect(packed.onLine).toContain('"z":"');
    expect(packed.onLine).not.toContain('"f":"{\\"t\\":\\"result\\"');
    expect(packed.onLine.length).toBeLessThan(plain.onLine.length / 4);
  });
});
