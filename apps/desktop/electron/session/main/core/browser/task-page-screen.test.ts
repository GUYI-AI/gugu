import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';
import type { TaskPageScreenFrame, TaskPageScreenTarget } from '../../../../server/server-task-browser';
import { connectTaskPageScreen, releaseHeld, taskPageInput, type HeldInput } from './task-page-screen';

const frame = { width: 1280, height: 720 };
const held = (): HeldInput => ({ buttons: new Set(), keys: new Set() });

describe('the person\'s input on a task page\'s picture, as page input (#1607 node 5)', () => {
  it('points land on the page\'s CSS pixels, with the buttons held and the modifiers pressed', () => {
    const own = held();
    expect(taskPageInput({ kind: 'pointer', action: 'down', x: 0.5, y: 0.25, button: 'left', modifiers: ['shift', 'control'] }, frame, own)).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 640, y: 180, modifiers: 10, buttons: 1, button: 'left', clickCount: 1 } },
    ]);
    expect(taskPageInput({ kind: 'pointer', action: 'move', x: 0.75, y: 0.5, button: 'left' }, frame, own)[0]!.params)
      .toMatchObject({ type: 'mouseMoved', x: 960, y: 360, buttons: 1, button: 'left' });
    expect(taskPageInput({ kind: 'pointer', action: 'up', x: 0.75, y: 0.5, button: 'left' }, frame, own)[0]!.params)
      .toMatchObject({ type: 'mouseReleased', buttons: 0, button: 'left', clickCount: 1 });
    expect(own.buttons.size).toBe(0);
  });

  it('wheel scrolls where it is; keys that type nothing carry their key code; text is inserted as typed', () => {
    const own = held();
    expect(taskPageInput({ kind: 'wheel', x: 0.1, y: 0.1, deltaX: 0, deltaY: 120 }, frame, own)[0]!.params)
      .toEqual({ type: 'mouseWheel', x: 128, y: 72, modifiers: 0, deltaX: 0, deltaY: 120 });
    expect(taskPageInput({ kind: 'key', action: 'down', key: 'Enter' }, frame, own)[0]!.params)
      .toEqual({ type: 'keyDown', key: 'Enter', modifiers: 0, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    expect(taskPageInput({ kind: 'key', action: 'down', key: 'ArrowDown' }, frame, own)[0]!.params)
      .toEqual({ type: 'rawKeyDown', key: 'ArrowDown', modifiers: 0, windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    expect(taskPageInput({ kind: 'key', action: 'down', key: 'a', modifiers: ['meta'] }, frame, own)[0]!.params)
      .toMatchObject({ key: 'a', modifiers: 4, windowsVirtualKeyCode: 65 });
    expect(taskPageInput({ kind: 'text', text: '你好' }, frame, own)).toEqual([{ method: 'Input.insertText', params: { text: '你好' } }]);
    // Leaving releases exactly what is still held.
    expect(releaseHeld(own).map(command => command.params)).toEqual([
      { type: 'keyUp', key: 'Enter' }, { type: 'keyUp', key: 'ArrowDown' }, { type: 'keyUp', key: 'a' },
    ]);
    expect(own.keys.size).toBe(0);
  });
});

function fakePage() {
  const emitter = new EventEmitter();
  let onFrame: ((frame: TaskPageScreenFrame) => void) | null = null;
  const page = {
    startScreen: vi.fn(async (listener: (frame: TaskPageScreenFrame) => void) => { onFrame = listener; }),
    stopScreen: vi.fn(async () => { onFrame = null; }),
    input: vi.fn(async () => ({})),
    isDestroyed: () => false,
    once: (event: 'destroyed', listener: () => void) => emitter.once(event, listener),
    state: vi.fn(() => ({ url: 'https://example.com/', title: 'Example', isLoading: false, canGoBack: false, canGoForward: false })),
    control: vi.fn(async () => {}),
    on: (event: 'state', listener: () => void) => emitter.on(event, listener),
    off: (event: 'state', listener: () => void) => emitter.off(event, listener),
  } satisfies TaskPageScreenTarget;
  return { page, paint: (data = 'aGVsbG8=') => onFrame?.({ data, width: 1280, height: 720 }), destroy: () => emitter.emit('destroyed'),
    changed: () => emitter.emit('state') };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('a task page watched from another computer', () => {
  it('starts painting for its first viewer, sends input against the picture shown, and stops with the last viewer', async () => {
    const { page, paint } = fakePage();
    const packets: ProjectionHostPacket[] = [];
    const viewer = await connectTaskPageScreen('task-screen-1', async () => page, packet => packets.push(packet));
    expect(page.startScreen).toHaveBeenCalledOnce();
    paint();
    await tick();
    const generation = (packets[0] as { generation: string }).generation;
    expect(packets.filter(p => p.type === 'frame').map(p => p.type === 'frame' && p.frame)).toEqual([
      { sequence: 1, width: 1280, height: 720, mime: 'image/jpeg', data: 'aGVsbG8=' }]);
    await viewer.receive({ type: 'ack', generation, frame: 1 });
    await viewer.receive({ type: 'input', generation, frame: 1, sequence: 1, input: { kind: 'pointer', action: 'down', x: 0.5, y: 0.5, button: 'left' } });
    expect(page.input).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 640, y: 360 }));
    viewer.close();
    await tick();
    // The held button is released, and nobody watching means no painting.
    expect(page.input).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', button: 'left' }));
    expect(page.stopScreen).toHaveBeenCalled();
  });

  it('the toolbar there sees where the page is as it changes, and drives it', async () => {
    const { page, changed } = fakePage();
    const states: unknown[] = [];
    const viewer = await connectTaskPageScreen('task-screen-3', async () => page, () => {}, state => states.push(state));
    expect(states).toEqual([expect.objectContaining({ url: 'https://example.com/', title: 'Example' })]);
    page.state.mockReturnValue({ url: 'https://example.org/', title: 'Org', isLoading: true, canGoBack: true, canGoForward: false });
    changed();
    expect(states.at(-1)).toEqual({ url: 'https://example.org/', title: 'Org', isLoading: true, canGoBack: true, canGoForward: false });
    await viewer.control({ action: 'back' });
    expect(page.control).toHaveBeenCalledWith({ action: 'back' });
    viewer.close();
    changed();
    // A viewer that left hears nothing more.
    expect(states).toHaveLength(2);
  });

  it('watching never opens a page, and a closed page ends its viewers', async () => {
    await expect(connectTaskPageScreen('task-without-page', async () => null, () => {})).rejects.toMatchObject({ code: 'not-found' });
    const { page, destroy } = fakePage();
    const packets: ProjectionHostPacket[] = [];
    await connectTaskPageScreen('task-screen-2', async () => page, packet => packets.push(packet));
    destroy();
    await tick();
    expect(packets.at(-1)).toMatchObject({ type: 'state', state: 'closed' });
  });
});
