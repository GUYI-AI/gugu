import type { ChatCommands } from '@gugu/session-chat-ui';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { MessageProvider } from '@gugu/session-ui/react/components';
import { ThemeProvider } from '@gugu/session-ui/react/primitives';
import { SessionTranscriptView } from '@/components/assistant-ui/session-transcript-view.aui';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { platform } from '@/platform';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@/mobile/phone-look.css';

/*
 * #2594: the phone's task page does not draw or fetch the pictures a tool call's result handed back; the desktop app
 * keeps them however narrow its window. "The phone" is the phone shell the transcript view checks: the native app, or the web
 * target at phone width. The transcript is handed its turns on the first render (a cold open), so this also covers the
 * first frame, before any later layout update could land.
 */

const cleanups: (() => void)[] = [];
const originalKind = Object.getOwnPropertyDescriptor(platform, 'kind')!;
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  Object.defineProperty(platform, 'kind', originalKind);
  vi.unstubAllGlobals();
});

const STRIP = '[data-slot="tool-call-images"]';
const shot = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
/** The agent is running and has just read a screenshot: the phone's copy of the record carries only the count. */
const running: TranscriptTurn = { id: 'running-turn', seq: 0, initiator: 'user', startedAt: 1000, items: [
  { kind: 'message', id: 'ask', seq: 0, role: 'user', text: 'Check the login page' },
  { kind: 'read-tool-call', id: 'read-shot', seq: 1, toolCallId: 'read-shot', title: 'Read', path: '/work/login.png', status: 'done',
    at: 2000, completedAt: 2500, parentToolCallId: null, imageRefs: [{ mimeType: 'image/png', chars: 9 }, { mimeType: 'image/png', chars: 9 }] },
] } as unknown as TranscriptTurn;

async function mount(kind: typeof platform.kind, width: number) {
  await page.viewport(width, 844);
  Object.defineProperty(platform, 'kind', { configurable: true, value: kind });
  vi.stubGlobal('__GUGU_SELF_IDENTITY__', { getSnapshot: () => ({ userId: 'owner', displayName: 'You', guguNumber: null }), subscribe: () => () => {} });
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = 'position:fixed;inset:0;display:flex;background:var(--background);color:var(--foreground)';
  const resolveToolImage = vi.fn<NonNullable<ChatCommands['resolveToolImage']>>(async () => shot);
  const commands: ChatCommands = { resolveToolImage };
  // Not even for a frame: a strip that mounts can be seen by the viewport observer and ask for its pictures.
  let stripMounted = false;
  const watch = new MutationObserver(() => { stripMounted ||= !!host.querySelector(STRIP); });
  watch.observe(host, { childList: true, subtree: true });
  const root = createRoot(host);
  root.render(<ThemeProvider><MessageProvider locale="en-US" translate={translateSessionMessage}>
    <SessionTranscriptView uri={`pictures-${kind}-${width}`} turns={[running]} mobile commands={commands} style={{ height: 800 }} />
  </MessageProvider></ThemeProvider>);
  cleanups.push(() => { watch.disconnect(); root.unmount(); host.remove(); });
  await until('the running step line is drawn', () => !!host.querySelector('[data-slot="tool-run"]'));
  return { host, resolveToolImage, stripMounted: () => stripMounted };
}

const frames = (n: number) => new Promise<void>(resolve => {
  const step = (left: number) => left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
  step(n);
});

it.each([
  { kind: 'capacitor' as const, width: 390 },
  { kind: 'web' as const, width: 390 },
])('$kind at $width px (the phone): the step stays, its pictures are not drawn or fetched', async ({ kind, width }) => {
  const { host, resolveToolImage, stripMounted } = await mount(kind, width);
  await frames(6);
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(host.querySelectorAll(STRIP)).toHaveLength(0);
  expect(stripMounted()).toBe(false);
  expect(resolveToolImage).not.toHaveBeenCalled();
});

it.each([
  { kind: 'electron' as const, width: 390 },
  { kind: 'web' as const, width: 1000 },
])('$kind at $width px (not the phone): the pictures are drawn and fetched as before', async ({ kind, width }) => {
  const { host, resolveToolImage, stripMounted } = await mount(kind, width);
  await until('the picture strip is drawn', () => host.querySelectorAll(STRIP).length === 1);
  await until('the pictures are fetched', () => resolveToolImage.mock.calls.length > 0);
  expect(resolveToolImage.mock.calls[0]).toEqual(['read-shot', 0]);
  expect(stripMounted()).toBe(true);
});
