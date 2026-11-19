import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { browserAnnotationSpaceChannel } from '@shared/events/browserEvents';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { useBrowserAnnotations } from '@renderer/features/browser/browser-annotations';
import { AnnotationEditor } from '@renderer/features/sessions/annotations/annotation-editor';
import { HtmlPreviewSurface } from '@/components/preview/HtmlPreviewSurface';
import { previewDocumentHtml } from '@shared/preview/preview-link-script';
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations';
import type { AnnotationConversation } from '@shared/browser-annotation';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@/styles/tokens.css';

const native = vi.hoisted(() => ({
  listeners: new Map<unknown, Set<(event: unknown) => void>>(),
  focusHost: vi.fn(async (_name: string) => ({ success: true })),
  setAnnotationBrowsing: vi.fn(async (_args: { browserId: string; browsing: boolean }) => ({ success: true })),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: (channel: unknown, listener: (event: unknown) => void) => {
    const listeners = native.listeners.get(channel) ?? new Set();
    listeners.add(listener); native.listeners.set(channel, listeners);
    return () => listeners.delete(listener);
  } },
  rpc: { browser: { focusHost: native.focusHost, setAnnotationBrowsing: native.setAnnotationBrowsing } },
  // The theme's device-preference store links the settings client (unused here: a web shell, no first-frame answer).
  rpcOn: () => ({}),
}));

vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => ({
  invoke: async () => ({ target: { url: 'preview', text: 'Page action', elementTag: 'button', selector: '#action',
    rect: { x: 0, y: 0, width: 600, height: 320 }, viewport: { width: 600, height: 320, scrollX: 0, scrollY: 0 } } }),
  eventOn: () => () => {},
}) }));

let harness: ReturnType<typeof createReactHarness> | null = null;
afterEach(async () => {
  await act(async () => { await userEvent.keyboard('{/Space}'); });
  harness?.cleanup(); harness = null;
  native.listeners.clear(); native.focusHost.mockReset();
  native.setAnnotationBrowsing.mockReset().mockResolvedValue({ success: true });
});

it('saves a selected target without requiring an optional comment', async () => {
  const save = vi.fn();
  harness = createReactHarness();
  await harness.render(<SessionLocalizationProvider><AnnotationEditor number={1} onSave={save} onCancel={() => {}} /></SessionLocalizationProvider>);
  const submit = harness.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(submit.disabled).toBe(false);
  await act(async () => { await userEvent.click(submit); });
  expect(save).toHaveBeenCalledExactlyOnceWith('');
});

function Fixture({ conversation = { kind: 'session', sessionId: 'focus-test' } }: { conversation?: AnnotationConversation } = {}) {
  const annotation = useBrowserAnnotations({ conversation, browserId: 'page', visible: true, available: true,
    inspect: async () => { throw new Error('This keyboard test does not inspect the page'); } });
  return <><input aria-label="Composer draft" defaultValue="Draft" />{annotation.toolbar}<div style={{ position: 'relative', height: 400 }}>{annotation.overlay}</div></>;
}

it.each<AnnotationConversation>([{ kind: 'chat', chatId: 'focus-group' }, { kind: 'session', sessionId: 'focus-test' }])('keeps the $kind canvas ready for another Space browse while letting its composer accept typing', async conversation => {
  await page.viewport(800, 600);
  harness = createReactHarness();
  await harness.render(<SessionLocalizationProvider><Fixture conversation={conversation} /></SessionLocalizationProvider>);
  const composer = harness.container.querySelector<HTMLInputElement>('input')!;
  composer.focus();
  await act(async () => { await userEvent.click(harness!.container.querySelector('button')!); });
  const canvas = () => harness!.container.querySelector<HTMLElement>('[data-browser-annotation-layer]');
  await until('entering annotation mode focuses its canvas', () => canvas() === document.activeElement);
  // On mac1 the host window restored the previously focused composer when the native guest released focus.
  native.focusHost.mockImplementation(async () => { composer.focus(); return { success: true }; });
  for (let i = 0; i < 2; i++) {
    await act(async () => { await userEvent.keyboard('{Space>}'); });
    await until('Space temporarily exposes the native page', () => canvas() === null);
    await act(async () => {
      for (const listener of native.listeners.get(browserAnnotationSpaceChannel) ?? []) listener({ browserId: 'page', pressed: false });
    });
    await until('the canvas regains focus after the native key release', () => canvas() === document.activeElement);
    await act(async () => { await userEvent.keyboard('{/Space}'); });
  }
  expect(composer.value).toBe('Draft');
  await userEvent.click(composer);
  await userEvent.keyboard(' ');
  expect(composer.value).toBe('Draft ');
  expect(canvas()).not.toBeNull();
});

it.each(['release', 'unmount'] as const)('ignores a late native browse acknowledgement after %s', async cancel => {
  let armed!: (result: { success: boolean }) => void;
  native.setAnnotationBrowsing.mockImplementationOnce(() => new Promise(resolve => { armed = resolve; }));
  harness = createReactHarness();
  await harness.render(<SessionLocalizationProvider><Fixture /></SessionLocalizationProvider>);
  await act(async () => { await userEvent.click(harness!.container.querySelector('button')!); });
  const canvas = () => harness!.container.querySelector<HTMLElement>('[data-browser-annotation-layer]');
  await until('the annotation canvas owns focus', () => canvas() === document.activeElement);
  await act(async () => { await userEvent.keyboard('{Space>}'); });
  expect(canvas()).not.toBeNull();
  expect(native.setAnnotationBrowsing).toHaveBeenCalledWith({ browserId: 'page', browsing: true });
  await act(async () => {
    if (cancel === 'release') await userEvent.keyboard('{/Space}');
    else { harness!.cleanup(); harness = null; }
  });
  expect(native.setAnnotationBrowsing).toHaveBeenCalledWith({ browserId: 'page', browsing: false });
  await act(async () => { armed({ success: true }); });
  if (cancel === 'release') expect(canvas()).not.toBeNull();
});

it('reopens a saved marker at its anchor, preserves its number and deletes from the page', async () => {
  await page.viewport(800, 600);
  const id = crypto.randomUUID();
  const draft = sessionAnnotations.forSession(id);
  const target = {
    url: 'https://example.org/', selector: '#intro', targetPath: 'p#intro', elementTag: 'p', text: 'Page quote',
    rect: { x: 100, y: 100, width: 200, height: 30 },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
  };
  const item = draft.add({ ...target, browserId: 'page', kind: 'browser', annotation: 'Original note', screenshot: new File([], 'note.png') }, 7);
  function MarkedPage() {
    const annotation = useBrowserAnnotations({ conversation: { kind: 'session', sessionId: id }, browserId: 'page', visible: true, available: true,
      inspect: async () => ({ target }) });
    return <>{annotation.toolbar}<div className="gugu-skin" style={{ position: 'relative', width: 780, height: 500 }}>{annotation.overlay}</div></>;
  }
  harness = createReactHarness();
  await harness.render(<SessionLocalizationProvider><MarkedPage /></SessionLocalizationProvider>);
  const root = harness.container;
  await act(async () => { await userEvent.click(root.querySelector('button[aria-pressed]')!); });
  const marker = () => root.querySelector<HTMLElement>('[data-annotation-marker="7"]');
  await until('the previously saved marker is visible on entry', () => !!marker());
  const markerBox = marker()!.getBoundingClientRect();

  await act(async () => { await userEvent.click(marker()!); });
  const editor = () => root.querySelector<HTMLFormElement>('[data-annotation-editor]');
  const field = () => editor()?.querySelector<HTMLInputElement>('input');
  expect(field()?.value).toBe('Original note');
  expect(editor()!.getBoundingClientRect().left).toBeCloseTo(markerBox.left);
  expect(editor()!.getBoundingClientRect().bottom).toBeLessThan(markerBox.top + 1);
  await act(async () => { field()!.select(); await userEvent.keyboard('Updated note{Enter}'); });
  expect(draft.items[0]).toMatchObject({ id: item.id, number: 7, annotation: 'Updated note' });
  expect(editor()).toBeNull();

  await act(async () => { await userEvent.click(marker()!); });
  await act(async () => { field()!.select(); await userEvent.keyboard('Discarded edit{Escape}'); });
  expect(draft.items[0]?.annotation).toBe('Updated note');
  expect(marker()).not.toBeNull();
  await act(async () => { await userEvent.click(marker()!); });
  await act(async () => { await userEvent.click(editor()!.querySelector('button')!); });
  expect(draft.items).toHaveLength(0);
  expect(marker()).toBeNull();
});


it('returns keyboard routing from a real opaque HTML iframe for another Space browse', async () => {
  await page.viewport(800, 600);
  harness = createReactHarness();
  const url = URL.createObjectURL(new Blob([previewDocumentHtml(`<button id="action" style="position:fixed;inset:0;width:100%;height:100%" onclick="parent.postMessage({type:'html-focus-click'},'*')">Page action</button>`)], { type: 'text/html' }));
  let clicks = 0;
  let hostSpaceDowns = 0;
  const childClick = (event: MessageEvent) => {
    if (event.source === harness?.container.querySelector('iframe')?.contentWindow && event.data?.type === 'html-focus-click') clicks++;
  };
  const hostKey = (event: KeyboardEvent) => { if (event.code === 'Space') hostSpaceDowns++; };
  window.addEventListener('message', childClick);
  window.addEventListener('keydown', hostKey);
  try {
    await harness.render(<SessionLocalizationProvider><div style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: 600, height: 360 }}>
      <HtmlPreviewSurface fileName="focus.html" url={url} onLink={() => {}} annotation={{ sessionId: 'html-focus-routing', path: 'focus.html' }} />
    </div></SessionLocalizationProvider>);
    await until('the loaded HTML preview offers annotations', () => !!harness!.container.querySelector('button'));
    await userEvent.click(harness.container.querySelector('button')!);
    const canvas = () => harness!.container.querySelector<HTMLElement>('[data-browser-annotation-layer]');
    const frame = harness.container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    for (let cycle = 0; cycle < 2; cycle++) {
      await until('the annotation canvas owns DOM focus', () => document.activeElement === canvas());
      await userEvent.keyboard('{Space>}');
      await until('Space exposes the real HTML frame on every cycle', () => canvas() === null);
      const before = clicks;
      await userEvent.click(frame);
      await until('the actual iframe button receives the click', () => clicks > before);
      await userEvent.keyboard('{/Space}');
      await until('iframe release restores the annotation canvas', () => !!canvas() && document.activeElement === canvas());
    }
    expect(hostSpaceDowns).toBe(2);
    expect(native.setAnnotationBrowsing).not.toHaveBeenCalled();
  } finally {
    await userEvent.keyboard('{/Space}');
    window.removeEventListener('message', childClick);
    window.removeEventListener('keydown', hostKey);
    URL.revokeObjectURL(url);
  }
});
