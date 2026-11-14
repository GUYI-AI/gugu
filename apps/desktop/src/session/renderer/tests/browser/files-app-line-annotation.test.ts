import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import * as cmView from '@codemirror/view';
import { EditorView } from '@codemirror/view';
// @ts-expect-error The preinstalled App is an unbundled ES module.
import { annotationLineNumbers } from '../../../../../preinstalled-apps/workspace/comments.js';
import { until } from '../../../../../../../tests/support/awaitCondition';

let host: HTMLDivElement, view: EditorView;
afterEach(() => { view?.destroy(); host?.remove(); });

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
