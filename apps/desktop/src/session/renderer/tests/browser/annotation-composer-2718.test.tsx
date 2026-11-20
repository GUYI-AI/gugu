import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ChatComposer } from '@gugu/session-ui/react/components';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { AnnotationTray } from '@renderer/features/sessions/annotations/annotation-tray';
import { sessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@/styles/tokens.css';
import '@/mobile/phone-shell.css';

let harness: ReturnType<typeof createReactHarness> | null = null;
afterEach(() => { harness?.cleanup(); harness = null; });

it('offers deletion without editing for saved diff comments', async () => {
  await page.viewport(390, 700);
  const id = crypto.randomUUID();
  const draft = sessionAnnotations.forSession(id);
  const first = draft.add({ kind: 'diff', path: 'notes.md', turnId: 'turn', patchIndex: 0, rowIndex: 0, newLine: 2, text: 'Source text', annotation: 'First note' });
  draft.add({ kind: 'diff', path: 'sample.ts', turnId: 'turn', patchIndex: 0, rowIndex: 1, oldLine: 8, text: 'Old line', annotation: 'Diff note' });
  harness = createReactHarness();
  await harness.render(<SessionLocalizationProvider><AnnotationTray conversation={{ kind: 'session', sessionId: id }} onSend={() => {}} enabled /></SessionLocalizationProvider>);
  await act(async () => { await userEvent.click(harness!.container.querySelector('[data-composer-annotations] button')!); });
  const buttons = () => document.querySelectorAll('button[aria-label="Delete annotation"],button[aria-label="删除批注"]');
  await until('both diff comments are listed', () => buttons().length === 2);
  expect(document.querySelector('button[aria-label="Edit annotation"],button[aria-label="修改批注"]')).toBeNull();
  expect(document.querySelector('[data-annotation-editor]')).toBeNull();
  await act(async () => { await userEvent.click(buttons()[0]!); });
  expect(draft.items.some(item => item.id === first.id)).toBe(false);
  expect(draft.items).toMatchObject([{ kind: 'diff', number: 2, annotation: 'Diff note' }]);
});

it('places one annotation attachment above the phone input with edit and delete for each comment', async () => {
  await page.viewport(390, 700);
  const id = crypto.randomUUID();
  const draft = sessionAnnotations.forSession(id);
  const screenshot = document.createElement('canvas');
  screenshot.width = 400;
  screenshot.height = 300;
  const pixels = screenshot.getContext('2d')!;
  pixels.fillStyle = '#ff0000';
  pixels.fillRect(10, 10, 100, 20);
  const png = await new Promise<Blob>(resolve => screenshot.toBlob(blob => resolve(blob!), 'image/png'));
  for (const n of [1, 2]) draft.add({ kind: 'browser', browserId: 'page', url: 'https://example.org/', selector: '#intro', targetPath: 'p#intro', elementTag: 'p',
    rect: { x: 10, y: 10, width: 100, height: 20 }, viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 }, text: 'Page quote',
    annotation: 'Browser note', screenshot: new File([png], `browser-comment-${n}.png`, { type: 'image/png' }) });
  const remove = vi.fn();
  harness = createReactHarness();
  await harness.render(<div data-phone-shell className="gugu-skin" style={{ width: 374, margin: 8 }}>
    <SessionLocalizationProvider><ChatComposer mobile canSubmit onSubmit={() => {}}
      attachmentExtra={<AnnotationTray conversation={{ kind: 'session', sessionId: id }} onSend={() => {}} onRemove={remove} enabled />} />
    </SessionLocalizationProvider>
  </div>);
  const attachment = harness.container.querySelector<HTMLElement>('[data-composer-annotations]')!;
  const editor = harness.container.querySelector<HTMLElement>('[data-slot="composer-input"]')!;
  await until('the annotation attachment has layout', () => attachment?.getBoundingClientRect().height > 0);
  expect(attachment.getBoundingClientRect().bottom).toBeLessThanOrEqual(editor.getBoundingClientRect().top);
  expect(attachment.getBoundingClientRect().right).toBeLessThanOrEqual(390);
  expect(attachment.textContent).not.toMatch(/[{}]/);
  await act(async () => {
    await userEvent.click(attachment.querySelector('button')!);
    await until('the annotation list is open', () => document.querySelectorAll('button[aria-label="Edit annotation"],button[aria-label="修改批注"]').length === 2);
  });
  const thumbnails = document.querySelectorAll('canvas');
  expect(thumbnails).toHaveLength(2);
  await until('the screenshot crop is drawn', () => thumbnails[0]!.getContext('2d')!.getImageData(48, 36, 1, 1).data[0] === 255);
  expect(document.body.textContent).toContain('<p>');
  expect(document.querySelectorAll('button[aria-label="Delete annotation"],button[aria-label="删除批注"]')).toHaveLength(2);
  const ids = draft.items.map(item => item.id);
  await act(async () => {
    await userEvent.keyboard('{Escape}');
    await userEvent.click(attachment.querySelectorAll('button')[1]!);
  });
  expect(draft.items).toHaveLength(0);
  expect(remove.mock.calls.map(([id]) => id)).toEqual(ids);
});
