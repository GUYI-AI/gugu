// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { yCollab } from 'y-codemirror.next';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { inkOn, leftCarets } from './remote-carets';

/**
 * Other people's carets in a bound editor, next to `yCollab`'s (remote-carets.ts). One whose owner left — a person
 * closed the file, an agent's call ended and took its connection — stays where it was, named, for 3 s and fades out
 * over 1 s: an agent's write is over within its call, and without this its caret would be gone before anyone saw it.
 */

const DOC = 'one two three';
const YELLOW = 'hsl(60, 65%, 45%)';
const BLUE = 'hsl(230, 65%, 45%)';
const CODEX = { id: 'agent-codex', name: 'Codex', color: '#e0792e' };
const WEI = { id: 'person-wei', name: 'Wei', color: '#3b82f6' };

let view: EditorView;
let doc: Y.Doc;
let here: Awareness;
let connected: boolean;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  connected = true;
  doc = new Y.Doc();
  doc.getText('content').insert(0, DOC);
  here = new Awareness(doc);
  const text = doc.getText('content');
  view = new EditorView({ parent: document.body, doc: DOC, extensions: [yCollab(text, here), leftCarets(text, here, () => connected)] });
});

afterEach(() => {
  view.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Another client on the same file: its presence reaches this editor as the file service relays it. */
function client(user: { id: string; name: string; color: string }) {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  const awareness = new Awareness(replica);
  const relay = (ids: number[]) => applyAwarenessUpdate(here, encodeAwarenessUpdate(awareness, ids), 'service');
  return {
    at(index: number | null) {
      const place = index === null ? null : Y.createRelativePositionFromTypeIndex(replica.getText('content'), index);
      awareness.setLocalState({ user, cursor: place && { anchor: place, head: place } });
      relay([awareness.clientID]);
    },
    leave() {
      removeAwarenessStates(here, [awareness.clientID], 'service');
      awareness.destroy();
    },
  };
}

const carets = () =>
  [...view.dom.querySelectorAll<HTMLElement>('.cm-ySelectionCaret')].map((caret) => ({
    name: caret.querySelector('.cm-ySelectionInfo')?.textContent,
    left: caret.classList.contains('cm-yLeft'),
    at: view.posAtDOM(caret),
  }));

describe('a caret whose owner left', () => {
  it("an agent's caret stays named where it wrote after its call ends, fades, and is gone after 4 s", () => {
    const codex = client(CODEX);
    codex.at(7);
    expect(carets()).toEqual([{ name: 'Codex', left: false, at: 7 }]);
    codex.leave();
    expect(carets()).toEqual([{ name: 'Codex', left: true, at: 7 }]);
    const left = view.dom.querySelector('.cm-yLeft')!;
    expect(getComputedStyle(left.querySelector('.cm-ySelectionInfo')!).opacity).toBe('1');
    // Over the text for seconds: taps go through to it.
    expect(getComputedStyle(left).pointerEvents).toBe('none');
    vi.advanceTimersByTime(3900);
    expect(carets()).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(carets()).toEqual([]);
  });

  it('stays with the text it was at while others write before it', () => {
    const codex = client(CODEX);
    codex.at(7);
    codex.leave();
    view.dispatch({ changes: { from: 0, insert: 'zero ' } });
    expect(carets()).toEqual([{ name: 'Codex', left: true, at: 12 }]);
  });

  it('the same agent back elsewhere (its next call) shows one caret, at its new place', () => {
    const first = client(CODEX);
    first.at(3);
    first.leave();
    const next = client(CODEX);
    next.at(9);
    expect(carets()).toEqual([{ name: 'Codex', left: false, at: 9 }]);
  });

  it('someone who had left the editor (no caret) leaves no caret behind when they go', () => {
    const wei = client(WEI);
    wei.at(3);
    wei.at(null);
    expect(carets()).toEqual([]);
    wei.leave();
    expect(carets()).toEqual([]);
  });

  it("this page going offline takes everyone's presence, and nobody is drawn as having left", () => {
    const wei = client(WEI);
    wei.at(3);
    connected = false;
    wei.leave();
    expect(carets()).toEqual([]);
  });
  it('the viewer clicks and types in the file while a caret that left is up: everyone else still shows, and so does the viewer', () => {
    // Focused, the binding sets this page's caret in the middle of the editor's update.
    Object.defineProperty(view, 'hasFocus', { get: () => true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const codex = client(CODEX);
    codex.at(7);
    codex.leave();
    view.dispatch({ selection: { anchor: 2 } });
    view.dispatch({ changes: { from: 2, insert: 'x' }, selection: { anchor: 3 } });
    expect((here.getLocalState() as { cursor?: unknown } | null)?.cursor).toBeTruthy();
    client(WEI).at(4);
    expect(carets()).toContainEqual({ name: 'Wei', left: false, at: 4 });
    expect(carets()).toContainEqual({ name: 'Codex', left: true, at: 8 });
  });
});

describe("the name on a caret that left, on the service's stamped colour", () => {
  afterEach(() => {
    delete document.documentElement.dataset.guguTheme;
  });

  it("a light stamp gets the theme's dark ink, a dark one white", () => {
    expect(inkOn(YELLOW)).toBe('var(--em-foreground)');
    expect(inkOn(BLUE)).toBe('var(--em-color-white)');
    document.documentElement.dataset.guguTheme = 'dark';
    expect(inkOn(YELLOW)).toBe('var(--em-background)');
    expect(inkOn(BLUE)).toBe('var(--em-color-white)');
  });

  it('the label is drawn in it', () => {
    const codex = client({ ...CODEX, color: YELLOW });
    codex.at(7);
    codex.leave();
    expect(view.dom.querySelector<HTMLElement>('.cm-yLeft .cm-ySelectionInfo')!.style.color).toBe('var(--em-foreground)');
  });
});
