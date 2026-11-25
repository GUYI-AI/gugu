/**
 * An .html attachment sent with a page size is drawn in place in its chat bubble (real MessageBubble, real CSS, a real
 * sandboxed frame): its box is that size before any byte arrives, the page then sets its height, the frame is unmounted
 * when the bubble is far off screen and its box keeps the height, and a bubble drawn again opens at that height. Without a
 * size it is the file card. The page's text reads on the bubble it sits in (own and received) in both themes.
 */
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import type { MemberProfileCardModel } from '@/components/MemberProfileCard';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/styles/tokens.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }));

// A 420px tall page that posts, once loaded, the colours its text, muted text and accent took and its scheme.
const PAGE = `<div style="height:420px"><span class="label">Opus</span> <span class="v">41.2</span> <span class="a">best</span></div>
<style>.v{color:var(--muted)}.a{color:var(--accent)}</style>
<script>addEventListener('load',function(){parent.postMessage({probe:'colors',fg:getComputedStyle(document.querySelector('.label')).color,muted:getComputedStyle(document.querySelector('.v')).color,accent:getComputedStyle(document.querySelector('.a')).color,scheme:getComputedStyle(document.documentElement).colorScheme},'*')})</script>`;
const pageUrl = URL.createObjectURL(new Blob([PAGE], { type: 'text/html' }));
const view = vi.hoisted(() => ({ current: { status: 'loading' } as Record<string, unknown> }));
vi.mock('@/lib/attachmentBytes', async (original) => ({
  ...(await original<object>()),
  attachmentMetadata: async () => ({ status: 'ready', revision: {} }),
  useAttachmentObjectUrl: (_source: unknown, variant: string, enabled: boolean) => {
    if (variant !== 'full') throw new Error(`a page reads its whole file, not ${variant}`);
    return { ...(enabled ? view.current : { status: 'loading' }), retry: () => undefined };
  },
}));

const { MessageBubble } = await import('@/components/chat/MessageBubble');

const lin: MemberProfileCardModel = { id: 'sender-1', displayName: 'Lin', avatar: null, email: null, type: 'human', role: 'member' } as MemberProfileCardModel;
const PAGE_CONTENT = '[附件] chart.html (text/html)\n[URL] https://files.test.local/chart.html\n[Size] 600\n[Kind] file';
const sized = (width: number, height: number) => ({ file_metadata: { status: 'ready', revision: { width, height } } } as unknown as Partial<MessageItem>);

let harness: ReturnType<typeof createReactHarness> | undefined;
let id = 0;
const previousTheme = document.documentElement.dataset.theme;
beforeAll(async () => { await i18n.changeLanguage('en-US'); });
afterEach(() => {
  harness?.cleanup();
  harness = undefined;
  view.current = { status: 'loading' };
  if (previousTheme) document.documentElement.dataset.theme = previousTheme;
  else delete document.documentElement.dataset.theme;
});

async function renderPage(overrides: Partial<MessageItem>, { isMine = false, messageId = `page-${++id}`, theme = 'light' as 'light' | 'dark' } = {}) {
  document.documentElement.dataset.theme = theme;
  harness = createReactHarness();
  harness.container.className = `em${theme}`;
  harness.container.style.cssText = 'width:900px;background:var(--background);color:var(--foreground)';
  await renderWithAppProviders(harness, createNode(MessageBubble, {
    msg: message({ id: messageId, sender_user_id: 'sender-1', created_at: '2026-11-25T09:41:00.000Z', content_type: 'attachment', content: PAGE_CONTENT, is_mine: isMine, ...overrides }),
    onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
    compactMobile: false, isGroup: true, memberProfile: lin, memberProfiles: { 'sender-1': lin },
  }));
  return harness.container;
}

const pageBox = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-html-page]');

/** The colours the page posts from inside its frame. */
function colorsPosted() {
  const posted: { current?: { fg: string; muted: string; accent: string; scheme: string } } = {};
  const onMessage = (event: MessageEvent) => { if (event.data?.probe === 'colors') posted.current = event.data; };
  window.addEventListener('message', onMessage);
  return { posted, stop: () => window.removeEventListener('message', onMessage) };
}

describe('an .html attachment with a page size', () => {
  it('holds the declared size before its bytes arrive', async () => {
    const root = await renderPage(sized(400, 300));
    await until('the page box rendered', () => pageBox(root) !== null);
    const box = pageBox(root)!.getBoundingClientRect();
    expect(box.width).toBeCloseTo(400, 0);
    expect(box.height).toBeCloseTo(300, 0);
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('.gg-hfile')).toBeNull();
  });

  it('is narrowed to its bubble at the declared aspect ratio', async () => {
    const root = await renderPage(sized(1600, 800));
    await until('the page box rendered', () => pageBox(root) !== null);
    const box = pageBox(root)!.getBoundingClientRect();
    expect(box.width).toBeLessThan(900);
    expect(box.height).toBeCloseTo(box.width / 2, 0);
  });

  it('loads its page in an opaque sandbox from a Blob URL, takes its height, lets the frame go off screen and remembers the height', async () => {
    view.current = { status: 'ready', objectUrl: pageUrl };
    const root = await renderPage(sized(400, 300), { messageId: 'remembered' });
    await until('the page reported its height', () => (pageBox(root)?.getBoundingClientRect().height ?? 0) > 400);
    const frame = root.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.src.startsWith('blob:')).toBe(true);
    expect(frame.src).not.toBe(pageUrl); // the file's bytes with the theme and bootstrap first, not the bytes alone
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    const height = pageBox(root)!.getBoundingClientRect().height;
    expect(height).toBeCloseTo(436, 0); // the page's 420px and the base sheet's 8px padding above and below

    // Far off screen: the frame goes, the box keeps the page's height; back near, the frame is mounted again.
    root.style.marginTop = '5000px';
    await until('the frame unmounted off screen', () => root.querySelector('iframe') === null);
    expect(pageBox(root)!.getBoundingClientRect().height).toBeCloseTo(height, 0);
    root.style.marginTop = '0px';
    await until('the frame mounted again near the screen', () => root.querySelector('iframe') !== null);

    // The same file drawn again (scrolled back to, another chat) opens at the height its page reported.
    harness!.cleanup();
    view.current = { status: 'loading' };
    const again = await renderPage(sized(400, 300), { messageId: 'remembered' });
    await until('the page box rendered', () => pageBox(again) !== null);
    expect(pageBox(again)!.getBoundingClientRect().height).toBeCloseTo(height, 0);
  });

  it('is a file card without a size', async () => {
    const root = await renderPage({});
    await until('the file card rendered', () => root.querySelector('.gg-hfile') !== null);
    expect(pageBox(root)).toBeNull();
  });

  it('is its file card when its bytes cannot be had', async () => {
    view.current = { status: 'failed', holder: null };
    const root = await renderPage(sized(600, 300));
    await until('the file card rendered', () => root.querySelector('.gg-hfile') !== null);
    expect(root.querySelector('iframe')).toBeNull();
  });
});

function rgba(css: string) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
}

/** `fg` as painted over the opaque `bg`. */
function over(fg: string, bg: string) {
  const [r, g, b, a] = rgba(fg), back = rgba(bg), alpha = a! / 255;
  return `rgb(${[r!, g!, b!].map((channel, index) => Math.round(channel * alpha + back[index]! * (1 - alpha))).join(',')})`;
}

function contrast(fg: string, bg: string) {
  const luminance = (css: string) => rgba(css).slice(0, 3).reduce((sum, value, index) => {
    const c = value / 255;
    return sum + [0.2126, 0.7152, 0.0722][index]! * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  }, 0);
  const a = luminance(over(fg, bg)), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe.each(['light', 'dark'] as const)('a page on its bubble in the %s theme', (theme) => {
  it.each([true, false])('reads on the bubble (own message: %s)', async (isMine) => {
    view.current = { status: 'ready', objectUrl: pageUrl };
    const { posted, stop } = colorsPosted();
    try {
      const root = await renderPage(sized(600, 300), { isMine, theme });
      await until('the page posts its colours', () => posted.current !== undefined);
      const colors = posted.current!;
      const bubble = root.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!;
      const background = getComputedStyle(bubble).backgroundColor;
      const where = `${theme} ${isMine ? 'own' : 'received'} bubble`;
      expect(rgba(background)[3], `${where}: the bubble has a fill`).toBe(255);
      expect(contrast(colors.fg, background), `${where}: page text ${colors.fg} on ${background}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.muted, background), `${where}: muted text ${colors.muted} on ${background}`).toBeGreaterThanOrEqual(3);
      expect(contrast(colors.accent, background), `${where}: accent ${colors.accent} on ${background}`).toBeGreaterThanOrEqual(3);
      // The frame stays transparent over the bubble only while it and its page share a scheme.
      expect(getComputedStyle(root.querySelector('iframe')!).colorScheme, where).toBe(colors.scheme);
    } finally {
      stop();
    }
  });
});
