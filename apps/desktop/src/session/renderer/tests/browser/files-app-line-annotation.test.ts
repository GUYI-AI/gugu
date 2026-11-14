import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import * as cmView from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import { documentToHtml } from '@gugu/session-chat-ui/markdown-html';
import { annotationPrompt, SessionAnnotations } from '../../features/sessions/annotations/session-annotations';
// @ts-expect-error The preinstalled App is an unbundled ES module.
import { annotationLineNumbers, previewSelectionLines } from '../../../../../preinstalled-apps/workspace/comments.js';
import { until } from '../../../../../../../tests/support/awaitCondition';

let host: HTMLDivElement, view: EditorView;
afterEach(() => { view?.destroy(); host?.remove(); document.getSelection()?.removeAllRanges(); });

it('selects a source line and a Shift range through the actual Files gutter', async () => {
  await page.viewport(900, 600);
  host = document.createElement('div');
  document.body.append(host);
  view = new EditorView({ parent: host, doc: 'def greet(name):\n    title = "Hi"\n    message = title + name\n    return message', extensions: [annotationLineNumbers({ view: cmView }), cmView.drawSelection()] });
  await until('the editor paints its line numbers', () => [...host.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].some(el => el.textContent === '4'));
  const number = (n: number) => [...host.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(el => el.textContent === String(n))!;
  await page.elementLocator(number(2)).click();
  expect(view.state.selection.main.from).toBe(view.state.doc.line(2).from);
  expect(view.state.selection.main.to).toBe(view.state.doc.line(2).to);
  await page.elementLocator(number(4)).click({ modifiers: ['Shift'] });
  expect(view.state.selection.main.from).toBe(view.state.doc.line(2).from);
  expect(view.state.selection.main.to).toBe(view.state.doc.line(4).to);
});

it('excludes the untouched next paragraph when a real triple-click selection ends at its start', async () => {
  await page.viewport(900, 600);
  host = document.createElement('div');
  host.innerHTML = `<div class="gg-md">${documentToHtml('# 批注验收\n\n本目录用于临时批注验收，记录本次提交的简要说明。\n\n第二段保留独立的源行。', { trust: 'chat', sourceLines: true })}</div>`;
  document.body.append(host);
  const first = host.querySelector<HTMLElement>('[data-line="3-3"]')!;
  const next = host.querySelector<HTMLElement>('[data-line="5-5"]')!;
  await page.elementLocator(first).tripleClick();
  const selection = document.getSelection()!;
  expect(selection.toString()).toContain(first.textContent);
  expect(selection.toString()).not.toContain(next.textContent);
  const range = selection.getRangeAt(0);
  expect([next, next.firstChild]).toContain(range.endContainer);
  expect(range.endOffset).toBe(0);
  const [startLine, endLine] = previewSelectionLines(range);
  const draft = new SessionAnnotations();
  draft.add({ kind: 'file', path: 'notes.md', startLine, endLine, text: selection.toString(), annotation: '第一段' });
  expect(JSON.parse(annotationPrompt('', draft.items).split(' (file)\n')[1]!)).toMatchObject({ path: 'notes.md', startLine: 3, endLine: 3 });
  // An end point before the first text character is the same boundary as the block's own offset 0.
  range.setEnd(next.firstChild!, 0);
  expect(previewSelectionLines(range)).toEqual([3, 3]);
  range.setEnd(next, 0);
  expect(previewSelectionLines(range)).toEqual([3, 3]);
  range.setEnd(next.firstChild!, 1);
  expect(previewSelectionLines(range), 'a genuinely selected next character includes its source line').toEqual([3, 5]);
});
