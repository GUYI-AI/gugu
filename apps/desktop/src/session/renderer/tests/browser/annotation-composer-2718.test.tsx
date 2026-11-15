import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
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

it('places one annotation attachment above the phone input and offers edit only for browser comments', async () => {
  await page.viewport(390, 700);
  const id = crypto.randomUUID();
  const draft = sessionAnnotations.forSession(id);
  draft.add({ kind: 'file', path: '/project/notes.md', startLine: 1, endLine: 2, text: 'File quote', annotation: 'File note' });
  draft.add({ kind: 'browser', browserId: 'page', url: 'https://example.org/', selector: '#intro', targetPath: 'p#intro',
    rect: { x: 10, y: 10, width: 100, height: 20 }, viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 }, text: 'Page quote',
    annotation: 'Browser note', screenshot: new File(['image'], 'browser-comment-1.png') });
  harness = createReactHarness();
  await harness.render(<div data-phone-shell className="gugu-skin" style={{ width: 374, margin: 8 }}>
    <SessionLocalizationProvider><ChatComposer mobile canSubmit onSubmit={() => {}}
      attachmentExtra={<AnnotationTray sessionId={id} onSend={() => {}} enabled />} />
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
    await until('the annotation list is open', () => document.querySelectorAll('button[aria-label="Edit annotation"],button[aria-label="修改批注"]').length === 1);
  });
  expect(document.querySelectorAll('button[aria-label="Delete annotation"],button[aria-label="删除批注"]')).toHaveLength(2);
});
