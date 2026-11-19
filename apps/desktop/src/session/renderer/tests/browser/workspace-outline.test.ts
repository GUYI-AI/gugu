import { afterAll, beforeAll, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import * as language from '@codemirror/language';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as lezerHighlight from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import * as autocomplete from '@codemirror/autocomplete';
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import workspaceCss from '../../../../../preinstalled-apps/workspace/style.css?raw';
import tokensCss from '@/styles/tokens.css?raw';
import uiCss from '@/session/app-runtime/ui/ui.css?raw';
import { appPaletteCss } from '@/session/app-runtime/ui/app-palette.mjs';
import { renderer } from '@/session/app-runtime/markdown-entry';
import '@/session/app-runtime/markdown.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

// Owner 11-14: a long Markdown document needs an outline to read and jump by, as Feishu has. The shipped Files App, its
// actual Markdown renderer (KaTeX, tables) and its shipped styles; only the host's file API is supplied. Presses go
// through Chromium. Judged on the page: where the outline sits against the reading column, where a press lands, which
// line is marked while the page scrolls, and when there is none.
const filler = 'A paragraph of reading that takes some room on the page, so that each section is longer than the pane.\n\n'.repeat(12);
const section = (n: number) => `### ${n}. Section $\\nabla f_${n}$\n\n${filler}| f | gradient |\n|---|---|\n| $a^\\top x$ | $a$ |\n\n$$\\frac{\\partial f}{\\partial X} = G$$\n\n${filler}`;
const long = `# Review notes\n\nThe title is the document's, not a section.\n\n## A. Tools\n\n${section(1)}${section(2)}## B. Models\n\n${section(3)}${section(4)}## C. Notes\n\nShort.\n\n## D. Errata\n\nShort too.\n`;
const short = '# Short\n\n## Only\n\nOne section.\n\n## Two\n\nAnother.\n';
const entry = { id: 'outline', chat: 'group', name: 'notes.md', path: 'notes.md', type: 'text', contentType: 'text/markdown', sourceMessageIds: [] };
const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');
ytext.insert(0, long);
const file = {
  entry, type: 'text', readOnly: false, status: 'online',
  get text() { return ytext.toString(); },
  onChange: (fn: (event: { local: boolean }) => void) => {
    const changed = () => fn({ local: true });
    ytext.observe(changed);
    return () => ytext.unobserve(changed);
  },
  onStatus: () => () => {}, close: () => {},
  presence: { self: { userId: 'reader', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
};
const verbs = {
  openLink: async () => {}, openBrowserTab: async () => {}, reportError: async (message: string) => { throw new Error(message); },
  files: { open: async () => file, readVersion: async () => file, onChanged: () => () => {}, list: async () => [entry] },
};
const gugu = {
  ...verbs,
  showContextMenu: async () => null,
  getContext: async () => ({ locale: 'en', themeMode: 'light', chat: { id: 'group', name: 'Group', kind: 'group', groupId: 'group' }, file: entry, capabilities: ['files:read', 'files:write'] }),
  onContextChanged: () => () => {}, onLink: () => () => {}, setTabTitle: async () => {},
  markdown: async () => ({ render: renderer(verbs) }),
  codemirror: async () => ({ EditorView: view.EditorView, EditorState: state.EditorState, basicSetup, markdown, markdownLanguage, view, state, language, autocomplete, lezerHighlight }),
  bind: { codemirror: (editor: view.EditorView) => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: file.text } });
    editor.dispatch({ effects: state.StateEffect.appendConfig.of(yCollab(ytext, null)) });
    return () => {};
  } },
};
const ownStyle = document.createElement('style');
const byId = (id: string) => document.getElementById(id)!;
const outline = () => byId('outline');
const items = () => [...outline().querySelectorAll<HTMLButtonElement>('.outline-item')];
const marked = () => items().findIndex((item) => item.getAttribute('aria-current') === 'location');
const headings = () => [...byId('preview').querySelectorAll<HTMLElement>('.gg-md > :is(h2, h3)')];
const column = () => byId('preview').querySelector('.gg-md')!.getBoundingClientRect();
const below = (heading: HTMLElement) => heading.getBoundingClientRect().top - byId('preview').getBoundingClientRect().top;
const shown = (element: HTMLElement) => element.getBoundingClientRect().width > 0;
// The reader moves the page (a wheel's turn, then where it lands): a pressed heading is no longer held.
const scrollTo = (top: number) => { byId('preview').dispatchEvent(new WheelEvent('wheel')); byId('preview').scrollTop = top; };

beforeAll(async () => {
  await page.viewport(1400, 800);
  ownStyle.textContent = appPaletteCss(tokensCss) + uiCss + workspaceCss;
  document.head.append(ownStyle);
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  Object.assign(window, { gugu });
  await import('@/session/app-runtime/ui/ui-entry');
  // @ts-expect-error — the built-in App is an unbundled ES module.
  await import('../../../../../preinstalled-apps/workspace/app.js');
  await until('the document is read, formulas and tables drawn', () => !!byId('preview').querySelector('.katex') && !!byId('preview').querySelector('table'));
});

afterAll(() => {
  const editor = document.querySelector<HTMLElement>('.cm-editor');
  if (editor) view.EditorView.findFromDOM(editor)?.destroy();
  ownStyle.remove();
  ydoc.destroy();
});

it('lists the sections, not the title, beside the reading column; a press lands on its heading and marks it', async () => {
  expect(document.body.dataset.mode).toBe('preview');
  await until('the outline is drawn', () => shown(outline()));
  // A formula in a heading reads as its glyphs once (KaTeX also writes it out for screen readers).
  expect(items().map((item) => [item.textContent, item.dataset.depth])).toEqual([
    ['A. Tools', '0'], ['1. Section ∇f1', '1'], ['2. Section ∇f2', '1'],
    ['B. Models', '0'], ['3. Section ∇f3', '1'], ['4. Section ∇f4', '1'],
    ['C. Notes', '0'], ['D. Errata', '0'],
  ]);
  expect(outline().getBoundingClientRect().right).toBeLessThanOrEqual(column().left);
  expect(marked()).toBe(-1);

  // Past tables and formulas: the heading comes to the top of the pane, and stays the marked line.
  await userEvent.click(items()[4]!);
  await until('the page scrolled to section 3', () => Math.abs(below(headings()[4]!) - 16) < 2);
  expect(marked()).toBe(4);

  // Near the end the heading cannot reach the top; the one pressed is still the one marked.
  await userEvent.click(items()[6]!);
  await until('the page scrolled to the end', () => byId('preview').scrollTop + byId('preview').clientHeight >= byId('preview').scrollHeight - 2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(marked()).toBe(6);
  await userEvent.click(items()[4]!);
  await until('back at section 3', () => Math.abs(below(headings()[4]!) - 16) < 2);

  // Reading on, the mark follows the section under the top of the pane.
  const preview = byId('preview');
  scrollTo(preview.scrollTop + below(headings()[5]!) - 16 - 40);
  await until('the mark stays on section 3 until 4 reaches the top', () => marked() === 4);
  scrollTo(preview.scrollTop + 80);
  await until('the mark moves to section 4', () => marked() === 5);
  scrollTo(0);
  await until('above the first section, nothing is marked', () => marked() === -1);
});

it('folds to a rail in the margin where the room beside the column is too narrow, and opens on hover', async () => {
  await page.viewport(1000, 800);
  // The pointer leaves the outline it last pressed: under it, the list would stay open.
  await userEvent.hover(byId('preview').querySelector('.gg-md > p')!);
  await until('the outline is a rail', () => outline().getBoundingClientRect().width <= 28);
  expect(outline().getBoundingClientRect().right).toBeLessThanOrEqual(column().left);
  await userEvent.hover(items()[1]!);
  await until('its list opens over the text', () => outline().getBoundingClientRect().width >= 200 && items()[1]!.textContent!.length > 0);
  expect(items()[1]!.getBoundingClientRect().height).toBeGreaterThan(10);
  await userEvent.click(items()[1]!);
  await until('the page scrolled to section 1', () => Math.abs(below(headings()[1]!) - 16) < 2);
  await page.viewport(1400, 800);
});

it('follows the document when it is drawn again for another theme', async () => {
  // Switching theme draws the document again (its diagrams are themed): new heading elements, the same outline.
  const before = headings()[2]!;
  document.documentElement.dataset.guguTheme = 'dark';
  await until('the document is drawn again', () => !before.isConnected);
  await userEvent.click(items()[2]!);
  await until('the page scrolled to section 2', () => Math.abs(below(headings()[2]!) - 16) < 2);
  expect(marked()).toBe(2);
  scrollTo(0);
  await until('the mark follows the scroll', () => marked() === -1);
  delete document.documentElement.dataset.guguTheme;
});

it('is only for reading, and only for a document with enough sections', async () => {
  byId('mode-edit').click();
  await until('editing hides it', () => !shown(outline()));
  byId('mode-preview').click();
  await until('reading shows it again', () => shown(outline()));
  ydoc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, short); });
  await until('two sections need no outline', () => byId('preview').textContent!.includes('Another') && !shown(outline()));
  expect(outline().hidden).toBe(true);
});
