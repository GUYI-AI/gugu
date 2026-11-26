/**
 * An html-render page reads on the bubble it sits in. The page's frame is transparent, so its text lies on the bubble's
 * fill: in an own-message bubble (the transcript's inverts the page, dark in a light theme; the IM one is its own grey)
 * the page once kept the window's text colour and its words vanished into the fill. Reading, through the real CSS:
 * the page's own text, muted text and accent, posted from inside the frame, against the bubble's background, in both themes.
 * Control: the agent's reply bubble, which does not invert.
 */
import { createChatContext, createChatState } from '@gugu/session-chat-ui';
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view';
import { Markdown } from '@/components/markdown/Markdown';
import { buildBubbleStyle } from '@/components/chat/messageBubbleStyle';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@gugu/session-shared/markdown.css';

type Colors = { fg: string; muted: string; accent: string; scheme: string };

const PAGE = `<span class="label">Opus</span> <span class="v">41.2</span> <span class="a">best</span>
<style>.v{color:var(--muted)}.a{color:var(--accent)}</style>
<script>addEventListener('load',function(){parent.postMessage({probe:'colors',fg:getComputedStyle(document.querySelector('.label')).color,muted:getComputedStyle(document.querySelector('.v')).color,accent:getComputedStyle(document.querySelector('.a')).color,scheme:getComputedStyle(document.documentElement).colorScheme},'*')})</script>`;
const TEXT = `Chart\n\n\`\`\`html-render\n${PAGE}\n\`\`\``;

const cleanups: (() => void)[] = [];
const previousTheme = document.documentElement.dataset.theme;
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  if (previousTheme) document.documentElement.dataset.theme = previousTheme;
  else delete document.documentElement.dataset.theme;
});

function hostFor(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  const host = document.body.appendChild(document.createElement('div'));
  host.className = `em${theme}`;
  host.style.cssText = 'position:fixed;inset:0;width:1000px;height:1200px;background:var(--background);color:var(--foreground)';
  return host;
}

/** What the page posts from inside its frame, and the frame and bubble it sits in. */
async function pageColors(host: HTMLElement, bubble: () => HTMLElement | null) {
  let colors: Colors | undefined;
  const onMessage = (event: MessageEvent) => {
    if (event.data?.probe === 'colors') colors = event.data;
  };
  window.addEventListener('message', onMessage);
  cleanups.push(() => window.removeEventListener('message', onMessage));
  await until('the page posts its colours', () => colors !== undefined);
  const frame = host.querySelector('iframe')!;
  return { colors: colors!, frame, background: getComputedStyle(bubble()!).backgroundColor };
}

async function transcript(theme: 'light' | 'dark', role: 'user' | 'assistant') {
  const host = hostFor(theme);
  const surface = host.appendChild(document.createElement('div'));
  surface.style.cssText = 'height:100%;display:flex';
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', agentConversation: true, userGutter: 0 } });
  const state = createChatState(context);
  state.transcript.history.seed([{ id: 'turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'page', seq: 0, role, text: TEXT },
  ] }]);
  const root = createRoot(surface);
  cleanups.push(() => { root.unmount(); state.dispose(); context.dispose(); host.remove(); });
  root.render(<AgentConversationView context={context} state={state} />);
  return pageColors(host, () => host.querySelector<HTMLElement>('[data-user-card]'));
}

async function chatBubble(theme: 'light' | 'dark') {
  const host = hostFor(theme);
  const bubble = host.appendChild(document.createElement('div'));
  const root = createRoot(bubble);
  cleanups.push(() => { root.unmount(); host.remove(); });
  root.render(<div data-testid="mine" style={{ ...buildBubbleStyle(true, false, false), width: 600 }}><Markdown trust="chat" content={TEXT} onAccent hardBreaks /></div>);
  return pageColors(host, () => host.querySelector<HTMLElement>('[data-testid=mine]'));
}

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

/** A pixel in the frame's bottom-left padding as painted (no page content there): the bubble shows through a transparent canvas. */
async function framePixel(frame: HTMLIFrameElement): Promise<number[]> {
  const shot = await page.screenshot({ element: frame, base64: true, save: false });
  const image = new Image();
  image.src = `data:image/png;base64,${shot}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  return [...ctx.getImageData(3, image.height - 3, 1, 1).data].slice(0, 3);
}

async function expectOnBubble(result: Awaited<ReturnType<typeof pageColors>>, where: string) {
  expectReadable(result, where);
  const fill = rgba(result.background).slice(0, 3);
  const pixel = await framePixel(result.frame);
  pixel.forEach((channel, index) => expect(Math.abs(channel - fill[index]!), `${where}: frame pixel ${pixel} on fill ${fill}`).toBeLessThanOrEqual(3));
}

function expectReadable({ colors, frame, background }: Awaited<ReturnType<typeof pageColors>>, where: string) {
  expect(rgba(background)[3], `${where}: the bubble has a fill`).toBe(255);
  expect(contrast(colors.fg, background), `${where}: page text ${colors.fg} on ${background}`).toBeGreaterThanOrEqual(4.5);
  expect(contrast(colors.muted, background), `${where}: muted text ${colors.muted} on ${background}`).toBeGreaterThanOrEqual(3);
  expect(contrast(colors.accent, background), `${where}: accent ${colors.accent} on ${background}`).toBeGreaterThanOrEqual(3);
  // The frame stays transparent over the bubble only while it and its page are both light (page.ts).
  expect(getComputedStyle(frame).colorScheme, where).toBe(colors.scheme);
}

it.each(['light', 'dark'] as const)('reads on the transcript bubbles in the %s theme', async theme => {
  for (const role of ['user', 'assistant'] as const) await expectOnBubble(await transcript(theme, role), `${theme} ${role}`);
});

it.each(['light', 'dark'] as const)('reads on my own chat bubble in the %s theme', async theme => {
  await expectOnBubble(await chatBubble(theme), `${theme} own chat bubble`);
});
