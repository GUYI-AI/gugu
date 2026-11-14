/** @jsxImportSource solid-js */
/**
 * Chromium contract for the `base` layout user pill (#4874 「对话视图」).
 *
 * Three things must hold at once, and each is read off the live DOM:
 *   1. measure() === offsetHeight under `base` exactly as under `classic`
 *      (the hug is paint, never layout).
 *   2. The pill sits on the right edge of the row and never enters the gutter.
 *   3. A short message hugs its text; a long one fills what the gutter leaves.
 * `classic` is the positive control: same code path, full-width card.
 */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { createChatCaches } from '@session-chat/core/caches';
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { ChatLayout } from '@session-chat/core/layout/preset';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import type { ChatMessage } from '@session-chat/model';
import type { ChatCommands } from '@session-chat/commands';
import { render } from 'solid-js/web';
import { describe, expect, it, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import { messageUnitDef, normalizeMessage } from './message.def';

const WIDTH = 640;
const GUTTER = 72;
const SINGLE: ChatLayout = { preset: 'single', userGutter: 0 };
const DOUBLE: ChatLayout = { preset: 'double', userGutter: GUTTER };

const SHORT: ChatMessage = { kind: 'message', id: 'u-short', role: 'user', text: 'Hello, can you help me?' };
const LONG: ChatMessage = {
  kind: 'message',
  id: 'u-long',
  role: 'user',
  text: 'Can you refactor the authentication module to use JWT tokens instead of session cookies, and add rate limiting middleware for the API endpoints?',
};

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

type Reading = {
  computed: number;
  /** 整行的高(附件条 + 气泡)—— `measure()` 报的就是这个数。 */
  dom: number;
  /** 只有气泡那一半。夹住长消息的上限只夹它。 */
  cardH: number;
  /** 这一行画出来的附件 chip 数(#5269)。 */
  chips: number;
  /** 画出来的气泡数:只有附件、没有正文时是 0。 */
  cards: number;
  left: number;
  right: number;
  width: number;
  hostRight: number;
  background: string;
  borderWidth: string;
  actionTop: number;
  actionRight: number;
  cardBottom: number;
  actionButtons: number;
  actionOpacity: string;
  focusedActionOpacity: string;
};

async function mountUser(item: ChatMessage, layout: ChatLayout, commands: ChatCommands = {}, focusActions = false): Promise<Reading> {
  const theme = buildChatTheme(DEFAULT_CONFIG, layout);
  const caches = createChatCaches();
  const measureCtx: MeasureCtx = {
    theme,
    width: WIDTH,
    isCollapsed: () => false,
    expanded: () => false,
    caches,
    expandedId: null,
  };
  const renderCtx: RenderCtx = {
    viewState: { isCollapsed: () => false },
    measureCtx: () => measureCtx,
  };
  const computed = messageUnitDef.measure(item, measureCtx, messageUnitDef.vars!);

  const host = document.createElement('div');
  host.style.width = `${WIDTH}px`;
  // ChatRoot stamps this on its root; the harness has no ChatRoot, so the host
  // plays that role for the paint-side selectors.
  host.dataset.chatLayout = layout.preset;
  document.body.appendChild(host);
  const Comp = messageUnitDef.Render;
  const dispose = render(
    () => (
      <ThemeContext.Provider value={() => theme}>
        <CachesContext.Provider value={caches}>
          <CommandsContext.Provider value={() => commands}>
            <Comp data={item} ctx={renderCtx} vars={messageUnitDef.vars!} />
          </CommandsContext.Provider>
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ),
    host
  );
  try {
    await nextPaint();
    const cards = host.querySelectorAll('[data-user-card]').length;
    const card = host.querySelector<HTMLElement>('[data-user-card]') ?? document.createElement('div');
    // ⚠️ `measure()` 报的是**整行**的高:附件条挂在气泡外面,是气泡的兄弟(#5269)。
    // 量气泡只会量到正文那一半 —— 那正是这几条在附件条搬家后红掉的原因。
    const root = host.firstElementChild as HTMLElement;
    const hostRect = host.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const actions = root.querySelector<HTMLElement>('[data-user-message-actions]');
    const actionButton = actions?.querySelector('button');
    if (!actions || !actionButton) throw new Error('user message actions did not mount');
    const actionOpacity = getComputedStyle(actions).opacity;
    const initialHeight = root.offsetHeight;
    if (focusActions) {
      actionButton.focus();
      await vi.waitFor(() => expect(getComputedStyle(actions).opacity).toBe('1'));
      expect(root.offsetHeight, 'revealing actions moved the message row').toBe(initialHeight);
    }
    return {
      computed,
      dom: root.offsetHeight,
      cardH: card.offsetHeight,
      chips: root.querySelectorAll('[data-attachment-chip]').length,
      cards,
      left: rect.left - hostRect.left,
      right: rect.right - hostRect.left,
      width: rect.width,
      hostRight: hostRect.width,
      background: cs.backgroundColor,
      borderWidth: cs.borderTopWidth,
      actionTop: actionButton.getBoundingClientRect().top,
      actionRight: actions.getBoundingClientRect().right - hostRect.left,
      cardBottom: rect.bottom,
      actionButtons: actions.querySelectorAll('button').length,
      actionOpacity,
      focusedActionOpacity: getComputedStyle(actions).opacity,
    };
  } finally {
    dispose();
    host.remove();
    caches.clearAll();
  }
}

describe('user message × layout preset contract (#4874)', () => {
  it('keyboard focus reveals the same action row without changing its height', async () => {
    // A pointer left over the row reveals it by hover before keyboard focus.
    await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: innerHeight - 1 });
    const r = await mountUser(SHORT, DOUBLE, {}, true);
    expect(r.computed).toBe(r.dom);
    expect(r.actionOpacity).toBe(matchMedia('(hover: none)').matches ? '1' : '0');
    expect(r.focusedActionOpacity).toBe('1');
  });

  it.each([SINGLE, DOUBLE])('message actions sit below the bubble without breaking its measured height ($preset)', async (layout) => {
    const r = await mountUser(SHORT, layout, { canRevertMessage: () => true, onEditMessage: () => {} });
    expect(r.computed).toBe(r.dom);
    expect(r.actionButtons).toBe(2);
    expect(r.actionTop - r.cardBottom).toBe(4);
    expect(Math.abs(r.actionRight - r.right)).toBeLessThanOrEqual(0.5);
  });

  it('classic (positive control): full-width card, measure === offsetHeight', async () => {
    const r = await mountUser(SHORT, SINGLE);
    expect(r.computed).toBe(r.dom);
    expect(r.left).toBe(0);
    expect(r.width).toBe(WIDTH);
    expect(r.borderWidth).toBe('1px');
  });

  it('base: short message hugs its text on the right edge, outside the gutter', async () => {
    const r = await mountUser(SHORT, DOUBLE);
    expect(r.computed).toBe(r.dom);
    // Right-aligned: the pill's right edge is the row's right edge.
    expect(Math.abs(r.right - r.hostRight)).toBeLessThanOrEqual(0.5);
    // Hugging: strictly narrower than what the gutter leaves.
    expect(r.width).toBeLessThan(WIDTH - GUTTER);
    // Never enters the gutter.
    expect(r.left).toBeGreaterThanOrEqual(GUTTER);
    // Borderless pill.
    expect(r.borderWidth).toBe('0px');
  });

  // A wrapped paragraph hugs its *widest line*, which ends wherever the last
  // word that still fit ended — a few px short of the inner width. So「fills」
  // is bounded by one word (≤ 10% here), never asserted as an exact width.
  it('base: long message fills what the gutter leaves, up to one word of slack', async () => {
    const r = await mountUser(LONG, DOUBLE);
    expect(r.computed).toBe(r.dom);
    const available = WIDTH - GUTTER;
    expect(r.width).toBeLessThanOrEqual(available + 0.5);
    expect(r.width).toBeGreaterThan(available * 0.9);
    expect(r.left).toBeGreaterThanOrEqual(GUTTER - 0.5);
    expect(Math.abs(r.right - r.hostRight)).toBeLessThanOrEqual(0.5);
  });

  it('base with a zero gutter (narrow viewport) may use the whole row', async () => {
    const r = await mountUser(LONG, { preset: 'double', userGutter: 0 });
    expect(r.computed).toBe(r.dom);
    expect(r.width).toBeLessThanOrEqual(WIDTH + 0.5);
    expect(r.width).toBeGreaterThan(WIDTH * 0.9);
    // Wider than the gutter would have allowed: the gutter really is gone.
    expect(r.width).toBeGreaterThan(WIDTH - GUTTER + 0.5);
  });

  it('mutation control: the base row height is not the classic row height', async () => {
    // Same text, different padding — if `effectiveMessageVars` were ignored on
    // either side of the contract, this pair would collapse to equal numbers
    // while the two measure === offsetHeight checks above stayed green.
    const classic = await mountUser(LONG, SINGLE);
    const base = await mountUser(LONG, DOUBLE);
    expect(base.dom).not.toBe(classic.dom);
  });
});

/**
 * 正文里的 `@[name](path)` 是引用:路径绝对也好、相对也好,都留在正文里画成胶囊,不升格成附件条上的
 * 一枚 chip(11-14 owner:引用文件那条消息「有点粗糙然后 layout 也不对」)。附件条只画结构化的附件
 * (`attachments` / `files`,11-01 起附件都走这条)。更早那些靠绝对路径送达的附件,如今也是正文里一枚胶囊。
 */
describe('a cite stays in the words; the strip draws attachments only', () => {
  it.each([
    'hello，这张图有什么\n@[image.png](/Users/me/Library/task-attachments/t1/abc-image.png)',
    '看下 @[notes.md](/Users/me/notes.md) 这份',
    '看下 @[server.ts](src/server.ts) 这个文件',
  ])('%s', async (text) => {
    const item = normalizeMessage({ kind: 'message', id: 'u-cite', role: 'user', text });
    expect(item.attachments ?? []).toEqual([]);
    expect(item.text).toBe(text);
    const r = await mountUser(item, DOUBLE);
    expect(r.computed).toBe(r.dom);
    expect(r.chips).toBe(0);
  });

  it('an attachment draws its chip and grows the card; with no words, no empty bubble; measure === offsetHeight', async () => {
    const image = { id: 'acp-1', name: 'image.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    const plain = await mountUser({ kind: 'message', id: 'u-plain', role: 'user', text: 'hello，这张图有什么' }, DOUBLE);
    const withImage = await mountUser(normalizeMessage({ kind: 'message', id: 'u-img', role: 'user', text: 'hello，这张图有什么', attachments: [image] }), DOUBLE);
    expect([withImage.chips, withImage.cards]).toEqual([1, 1]);
    expect(withImage.computed).toBe(withImage.dom);
    expect(withImage.dom).toBeGreaterThan(plain.dom);
    for (const layout of [DOUBLE, SINGLE]) {
      const only = await mountUser(normalizeMessage({ kind: 'message', id: 'u-only', role: 'user', text: '', attachments: [image] }), layout);
      expect([only.chips, only.cards]).toEqual([1, 0]);
      expect(only.computed).toBe(only.dom);
    }
  });
});

it('projects task file references into existing name chips without changing the raw caption', () => {
  const item = normalizeMessage({ ...SHORT, files: [{ itemId: 'brief', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] });
  expect(item.text).toBe(SHORT.text);
  expect(item.attachments).toEqual([{ id: 'brief:1', name: 'brief.txt', kind: 'file' }]);
});

it('projects a task image reference as an image the host can resolve', () => {
  const item = normalizeMessage({ ...SHORT, files: [{ itemId: 'shot', version: 2, name: 'shot.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }] });
  expect(item.attachments).toEqual([{ id: 'gugu-file://shot?v=2', href: 'gugu-file://shot?v=2', name: 'shot.jpg', kind: 'image' }]);
});
