import { describe, expect, it, vi } from 'vitest';
import { createAckPressureSender, messageBytes } from './ipc-pressure';

describe('IPC byte pressure', () => {
  it('accounts for escaped control characters and unpaired surrogates without serializing a second copy', () => {
    for (const text of ['a\n\u0000"\\中🙂', '\ud800', '\udc00']) {
      const value = { data: text };
      expect(messageBytes(value)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(value)));
    }
  });
  it('pauses producers at a byte budget and resumes only after the parent acknowledges', () => {
    const pressure = vi.fn();
    const sent: unknown[] = [];
    const sender = createAckPressureSender((message) => sent.push(message), pressure, 1024);
    for (let n = 0; n < 4; n++) sender.send({ data: 'x'.repeat(256) });
    expect(sent).toHaveLength(4);
    expect(pressure.mock.calls).toEqual([[true]]);
    sender.ack(1);
    expect(pressure.mock.calls).toEqual([[true]]);
    sender.ack(3);
    expect(pressure.mock.calls).toEqual([[true], [false]]);
    expect(sender.pendingBytes).toBe(0);
  });

  it('ignores acks beyond what is in flight (a restarted parent counter)', () => {
    const pressure = vi.fn();
    const sender = createAckPressureSender(() => {}, pressure, 128);
    sender.send('x'.repeat(100));
    sender.ack(5);
    expect(sender.pendingBytes).toBe(0);
    sender.send('x'.repeat(100));
    expect(sender.pendingBytes).toBeGreaterThan(0);
  });

  it('delivers a history reply with a 33 MiB inline image without a fatal message-size exception', () => {
    const sent: unknown[] = [];
    const pressure = vi.fn();
    const sender = createAckPressureSender((message) => sent.push(message), pressure);
    const reply = { kind: 'result', id: 'history', ok: true, value: { success: true, data: { turns: [{ image: { data: 'A'.repeat(33 * 1024 * 1024) } }] } } };
    expect(() => sender.send(reply)).not.toThrow();
    expect(sent).toEqual([reply]);
    expect(sender.pendingBytes).toBeGreaterThan(32 * 1024 * 1024);
    expect(pressure).toHaveBeenLastCalledWith(true);
    sender.ack(1);
    expect(sender.pendingBytes).toBe(0);
    expect(pressure).toHaveBeenLastCalledWith(false);
  });
});
