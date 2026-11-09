import type { ProjectionFrame, ProjectionHostPacket, ProjectionInput } from '@shared/extensions/projection-protocol';
import { PROJECTION_FRAME_BYTES } from '@shared/extensions/projection-protocol';
import type { TaskPageControl, TaskPageState } from '@shared/browser-task-page';
import { ExtensionProjections } from '../extensions/extension-projections';
import type { TaskPageScreenTarget } from '../../../../server/server-task-browser';

/**
 * #1607 node 5 — a task's page, seen and taken over from another of the person's computers.
 *
 * The page is gugu's own (on a Gugu server, a page of the account's headless Chromium): on the person's own computer it
 * shows in the built-in browser tab and they click into it directly; from another computer the same tab shows its live
 * picture and their input goes to the page directly too. No App is involved. Pictures are the page's own screencast
 * (JPEG on every paint), paced by the shared projection rules: one picture in flight until the viewer showed it, input
 * only against the picture they saw, held keys and buttons released when a viewer leaves.
 */
const screens = new ExtensionProjections(() => {});
/** The projection principal of a task's page: gugu's own, not an App's. */
const TASK_PAGE = 'gugu:task-page';

type Open = { id: string; viewers: number; page: TaskPageScreenTarget; close(): Promise<void> };
const open = new Map<string, Promise<Open>>();

type CdpInput = { method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText'; params: Record<string, unknown> };
const MODIFIER_BITS = { alt: 1, control: 2, meta: 4, shift: 8 } as const;
const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const;
/** Keys that type nothing, by their DOM `key`: the virtual key code Chromium needs to act on them. */
const KEY_CODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35,
  Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Meta: 91,
};

/** What is held down per viewer, so leaving releases exactly that. */
export type HeldInput = { buttons: Set<'left' | 'middle' | 'right'>; keys: Set<string> };

/** One person's input, as Chromium input on the page's CSS pixels (the frame's input space). */
export function taskPageInput(input: ProjectionInput, frame: Pick<ProjectionFrame, 'width' | 'height'>, held: HeldInput): CdpInput[] {
  const modifiers = ('modifiers' in input ? input.modifiers ?? [] : []).reduce((bits, name) => bits | MODIFIER_BITS[name], 0);
  const at = (x: number, y: number) => ({ x: Math.round(x * frame.width * 100) / 100, y: Math.round(y * frame.height * 100) / 100 });
  const buttons = () => [...held.buttons].reduce((bits, name) => bits | BUTTON_BITS[name], 0);
  switch (input.kind) {
    case 'pointer': {
      if (input.action === 'down') held.buttons.add(input.button);
      if (input.action === 'up') held.buttons.delete(input.button);
      const type = input.action === 'move' ? 'mouseMoved' : input.action === 'down' ? 'mousePressed' : 'mouseReleased';
      return [{ method: 'Input.dispatchMouseEvent', params: { type, ...at(input.x, input.y), modifiers, buttons: buttons(),
        button: input.action === 'move' ? ([...held.buttons][0] ?? 'none') : input.button, ...(input.action === 'move' ? {} : { clickCount: 1 }) } }];
    }
    case 'wheel':
      return [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', ...at(input.x, input.y), modifiers, deltaX: input.deltaX, deltaY: input.deltaY } }];
    case 'key': {
      if (input.action === 'down') held.keys.add(input.key); else held.keys.delete(input.key);
      const code = KEY_CODES[input.key] ?? (input.key.length === 1 ? input.key.toUpperCase().charCodeAt(0) : undefined);
      // Enter acts (submits a form, adds a line) through the character it types: a key-down without it does nothing.
      // Everything else that types arrives as text; the rest acts on its key code alone.
      const typed = input.action === 'down' && input.key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : null;
      return [{ method: 'Input.dispatchKeyEvent', params: { type: input.action === 'down' ? (typed ? 'keyDown' : 'rawKeyDown') : 'keyUp', key: input.key, modifiers,
        ...(code === undefined ? {} : { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }), ...typed } }];
    }
    case 'text':
      return [{ method: 'Input.insertText', params: { text: input.text } }];
  }
}

/** Releases for everything a viewer still holds. */
export function releaseHeld(held: HeldInput): CdpInput[] {
  const out: CdpInput[] = [];
  for (const button of held.buttons) out.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 0, y: 0, button, buttons: 0, clickCount: 1 } });
  for (const key of held.keys) out.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key } });
  held.buttons.clear(); held.keys.clear();
  return out;
}

async function openScreen(sessionId: string, page: TaskPageScreenTarget): Promise<Open> {
  const held = new Map<string, HeldInput>();
  let sequence = 0;
  let starting: Promise<void> | null = null;
  const handle = screens.open({ extensionId: TASK_PAGE, sessionId }, {
    async input(input, { frame, viewer }) {
      const own = held.get(viewer) ?? { buttons: new Set(), keys: new Set() };
      held.set(viewer, own);
      for (const command of taskPageInput(input, frame, own)) await page.input(command.method, command.params);
    },
    async disconnect(viewer) {
      const own = held.get(viewer);
      held.delete(viewer);
      if (own) for (const command of releaseHeld(own)) await page.input(command.method, command.params).catch(() => {});
    },
    // A new viewer gets the current picture: starting the screencast again paints it at once.
    refresh() {
      starting = page.startScreen((frame) => {
        if (frame.data.length * 3 / 4 > PROJECTION_FRAME_BYTES) return;
        handle.publish({ sequence: ++sequence, width: frame.width, height: frame.height, mime: 'image/jpeg', data: frame.data });
      });
      void starting.catch(() => { void handle.close(); });
    },
    async close() { await starting?.catch(() => {}); await page.stopScreen(); },
  });
  page.once('destroyed', () => { void handle.close(); });
  return { id: handle.id, viewers: 0, page, close: () => handle.close() };
}

/**
 * Watch a task's page for another computer. `page` finds the task's existing page; watching never opens one. The last
 * viewer leaving stops the screencast.
 */
export async function connectTaskPageScreen(sessionId: string, page: () => Promise<TaskPageScreenTarget | null>,
  send: (packet: ProjectionHostPacket) => void, state: (state: TaskPageState) => void = () => {},
): Promise<{ receive(packet: unknown): Promise<void>; control(control: TaskPageControl): Promise<void>; close(): void }> {
  let entry = open.get(sessionId);
  if (!entry) {
    const target = await page();
    if (!target) throw Object.assign(new Error('This task has no browser page'), { code: 'not-found' });
    entry = open.get(sessionId) ?? openScreen(sessionId, target);
    open.set(sessionId, entry);
    void entry.catch(() => { if (open.get(sessionId) === entry) open.delete(sessionId); });
  }
  const screen = await entry;
  let viewer: ReturnType<ExtensionProjections['connect']>;
  try {
    viewer = screens.connect({ extensionId: TASK_PAGE, sessionId }, screen.id, { transport: 'device', send, onClose: () => () => {} });
  } catch (error) {
    // The page went away since: the next watch opens it afresh.
    if (open.get(sessionId) === entry) open.delete(sessionId);
    throw error;
  }
  screen.viewers += 1;
  let closed = false;
  // The toolbar there: where the page is, its title, whether it is loading, whether it can go back or forward.
  const report = () => state(screen.page.state());
  screen.page.on('state', report);
  report();
  return {
    receive: viewer.receive,
    control: (control) => screen.page.control(control),
    close() {
      if (closed) return;
      closed = true;
      screen.page.off('state', report);
      viewer.close();
      screen.viewers -= 1;
      if (screen.viewers === 0 && open.get(sessionId) === entry) {
        open.delete(sessionId);
        void screen.close().catch(() => {});
      }
    },
  };
}
