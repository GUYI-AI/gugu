import { Annotation, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

/**
 * A caret whose owner left — a person closed the file, an agent's call ended and took its connection — stays where it
 * was, named, for 3 s and fades out over 1 s, unless the same person or agent already has a caret here. An agent's write
 * is over within its call: without this its caret would be gone before anyone saw it.
 *
 * Next to `yCollab`'s own remote carets, drawn in their look (`cm-ySelectionCaret`), which only says who is here now.
 * Its state is gone by the time awareness says `removed`, so the last caret each client said is kept here.
 */

const LEFT_MS = 4000;
const FADE_MS = 1000;

type Said = { cursor: { head: unknown }; user?: { id?: unknown; name?: unknown; color?: unknown } };
type Left = Said & { at: number };

const redraw = Annotation.define<null>();

class LeftCaret extends WidgetType {
  constructor(
    readonly color: string,
    readonly name: string,
    readonly at: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'cm-ySelectionCaret cm-yLeft';
    caret.style.backgroundColor = caret.style.borderColor = this.color;
    caret.style.animationDelay = `${LEFT_MS - FADE_MS - (Date.now() - this.at)}ms`;
    const dot = document.createElement('div');
    dot.className = 'cm-ySelectionCaretDot';
    const info = document.createElement('div');
    info.className = 'cm-ySelectionInfo';
    info.textContent = this.name;
    info.style.color = inkOn(this.color);
    caret.append('⁠', dot, '⁠', info, '⁠');
    return caret;
  }

  eq(other: LeftCaret): boolean {
    return other.color === this.color && other.name === this.name && other.at === this.at;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * The name's colour on the stamped one: white on about half the hues is under 3:1, so a light stamp gets the theme's
 * near-black ink instead (the foreground in light, the background in dark) — at worst 4.2:1 either way.
 */
export function inkOn(color: string): string {
  const light = luminanceOf(color) > 0.179;
  if (!light) return 'var(--em-color-white)';
  return document.documentElement.dataset.guguTheme === 'dark' ? 'var(--em-background)' : 'var(--em-foreground)';
}

/** Relative luminance of the service's stamp, `hsl(h, s%, l%)`, or of a `#rrggbb`; 0 for anything else. */
function luminanceOf(color: string): number {
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(color);
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  let rgb: number[];
  if (hsl) {
    const [h, s, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100];
    const at = (n: number) => {
      const k = (n + h / 30) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    rgb = [at(0), at(8), at(4)];
  } else if (hex) rgb = hex.slice(1).map((part) => parseInt(part, 16) / 255);
  else return 0;
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const personOf = (said: Said) => (typeof said.user?.id === 'string' ? said.user.id : null);

/** `connected`: whether this page's own connection is up — when it drops, everyone's presence goes, and nobody left. */
export function leftCarets(ytext: Y.Text, awareness: Awareness, connected: () => boolean): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private said = new Map<number, Said>();
      private left = new Map<number, Left>();
      private timer: ReturnType<typeof setTimeout> | null = null;
      private readonly heard: (change: { added: number[]; updated: number[]; removed: number[] }) => void;

      constructor(private readonly view: EditorView) {
        this.keep();
        this.heard = ({ added, updated, removed }) => {
          // This page's own caret is set by yCollab in the middle of an editor update, where a dispatch would throw and
          // take its remote carets down with it; as there, only other clients count.
          if (![...added, ...updated, ...removed].some((id) => id !== awareness.clientID)) return;
          const now = Date.now();
          if (connected()) {
            for (const id of removed) {
              const said = this.said.get(id);
              if (!said) continue;
              const who = personOf(said);
              for (const [other, left] of this.left) if (who !== null && personOf(left) === who) this.left.delete(other);
              this.left.set(id, { ...said, at: now });
            }
          }
          this.keep();
          if (removed.length > 0 || this.left.size > 0) view.dispatch({ annotations: redraw.of(null) });
        };
        awareness.on('change', this.heard);
        this.decorations = this.draw();
      }

      /** The last caret each other client said. */
      private keep(): void {
        this.said = new Map();
        for (const [id, state] of awareness.getStates()) {
          if (id !== awareness.clientID && (state as Partial<Said> | null)?.cursor) this.said.set(id, state as Said);
        }
      }

      update(_update: ViewUpdate): void {
        this.decorations = this.draw();
      }

      private draw(): DecorationSet {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.left.size === 0) return Decoration.none;
        const now = Date.now();
        const here = new Set([...this.said.values()].map(personOf).filter((who) => who !== null));
        const ydoc = ytext.doc;
        const carets = [];
        let next = Infinity;
        for (const [id, left] of this.left) {
          const who = personOf(left);
          if (now - left.at >= LEFT_MS || (who !== null && here.has(who)) || !ydoc) {
            this.left.delete(id);
            continue;
          }
          next = Math.min(next, left.at + LEFT_MS - now);
          const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(left.cursor.head), ydoc);
          if (!at || at.type !== ytext) continue;
          // Stamped by the file service on every state; without it there is nobody to draw.
          const { name, color } = left.user ?? {};
          if (typeof color !== 'string') continue;
          const widget = new LeftCaret(color, typeof name === 'string' ? name : '', left.at);
          carets.push(Decoration.widget({ widget, side: 1 }).range(Math.min(at.index, this.view.state.doc.length)));
        }
        this.timer = next === Infinity ? null : setTimeout(() => this.view.dispatch({ annotations: redraw.of(null) }), next + 16);
        return Decoration.set(carets, true);
      }

      destroy(): void {
        awareness.off('change', this.heard);
        if (this.timer) clearTimeout(this.timer);
      }
    },
    { decorations: (value) => value.decorations },
  );
  return [
    plugin,
    EditorView.baseTheme({
      '.cm-ySelectionCaret.cm-yLeft': {
        animation: `cm-yCaretLeave ${FADE_MS}ms ${LEFT_MS - FADE_MS}ms forwards`,
        // Over the text for seconds: taps go through it.
        pointerEvents: 'none',
      },
      '.cm-ySelectionCaret.cm-yLeft > .cm-ySelectionInfo': { opacity: 1 },
      '@keyframes cm-yCaretLeave': { to: { opacity: 0 } },
    }),
  ];
}
