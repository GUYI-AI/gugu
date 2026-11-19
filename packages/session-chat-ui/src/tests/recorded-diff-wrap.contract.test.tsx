/** @jsxImportSource solid-js */
import type { SessionPatch } from '@gugu/session-core/acp';
import { expect, it } from 'vitest';
import { createChatContext } from '../chat-context';
import { mountRecordedFileDiff, type RecordedDiffAnnotationSlot } from '../components/rows/tools/diff/recorded-file-diff';
import { langFromPath } from '../components/rows/tools/diff/lang';
import { diffUnitDef } from '../components/rows/tools/diff/diff.def';
import { makeContractCtx, renderAndMeasureUnit } from './contract';

const prose = '这是一段必须完整显示的中文说明，continued text with spaces. '.repeat(24);
const code = `const longIdentifier = "${'unbroken_identifier_'.repeat(100)}";`;
const oldText = `previous ${code}`;
const patch = (path: string, text: string): SessionPatch => ({
  scope: 'file',
  changes: [{ operation: 'modify', path }],
  patch: { format: 'git_patch', text: `--- a/${path}\n+++ b/${path}\n@@ -7,2 +8,2 @@\n-${oldText}\n+${text}\n unchanged\n` },
});
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const contentOf = (slot: RecordedDiffAnnotationSlot) => slot.control.parentElement!.lastElementChild as HTMLElement;

it.each([
  { path: 'notes.md', text: prose, width: 240 },
  { path: 'notes.md', text: prose, width: 800 },
  { path: 'sample.ts', text: code, width: 240 },
  { path: 'sample.ts', text: code, width: 800 },
])('wraps $path at $width px without changing source rows or annotation targets', async ({ path, text, width }) => {
  const context = createChatContext({ locale: () => 'zh-CN' });
  const host = document.createElement('div');
  host.style.cssText = `width:${width}px;overflow:auto`;
  document.body.append(host);
  const slots: RecordedDiffAnnotationSlot[] = [];
  const recorded = mountRecordedFileDiff(host, context, {
    turnId: 'wrapped-turn', path, patches: [patch(path, text), patch(path, text)],
  }, slot => slots.push(slot));
  const selection = window.getSelection()!;
  try {
    await Promise.all([oldText, text, 'unchanged'].map(line => context.sharedCaches.highlightWhenReady(line, langFromPath(path))));
    await paint();
    const lineHeight = context.theme.fonts.code.lineHeight;
    const expected = [0, 1].flatMap(patchIndex => [
      { patchIndex, rowIndex: 1, oldLine: 7, newLine: undefined, text: oldText },
      { patchIndex, rowIndex: 2, oldLine: undefined, newLine: 8, text },
      { patchIndex, rowIndex: 3, oldLine: 8, newLine: 9, text: 'unchanged' },
    ]);
    const metadata = () => slots.map(({ control: _control, editor: _editor, ...source }) => source);
    expect(metadata()).toEqual(expected);
    expect(host.querySelectorAll('[data-patch-row]')).toHaveLength(8);

    // One control and marker per logical source row, even across several visual lines.
    slots.forEach((slot, index) => {
      const button = document.createElement('button');
      button.textContent = String(index + 1);
      slot.control.append(button);
    });
    const verify = () => {
      const bounds = host.getBoundingClientRect();
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      for (const slot of slots) {
        const row = slot.control.parentElement!;
        const content = contentOf(slot);
        const marker = slot.control.nextElementSibling as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(content);
        const fragments = [...range.getClientRects()].filter(rect => rect.width > 0);
        expect(content.textContent).toBe(slot.text);
        expect(fragments.length).toBeGreaterThan(0);
        for (const rect of fragments) {
          expect(rect.left).toBeGreaterThanOrEqual(content.getBoundingClientRect().left - 1);
          expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
        }
        if (slot.text !== 'unchanged') {
          expect(new Set(fragments.map(rect => Math.round(rect.top))).size).toBeGreaterThan(1);
          expect(row.getBoundingClientRect().height).toBeGreaterThan(lineHeight * 1.5);
        }
        expect(Math.abs(marker.getBoundingClientRect().top - row.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
        expect(slot.control.getBoundingClientRect().height).toBe(lineHeight);
        expect(row.querySelectorAll('button')).toHaveLength(1);
        expect(marker.textContent).toBe(slot.oldLine === undefined ? '+' : slot.newLine === undefined ? '−' : ' ');
        expect(row.getAttribute('data-old-line')).toBe(slot.oldLine === undefined ? null : String(slot.oldLine));
        expect(row.getAttribute('data-new-line')).toBe(slot.newLine === undefined ? null : String(slot.newLine));
        expect(slot.editor.previousElementSibling).toBe(row);
      }
    };
    verify();
    const added = slots[1]!;
    const range = document.createRange();
    range.selectNodeContents(contentOf(added));
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe(text);
    // Resizing only reflows glyphs; it neither registers new annotation rows nor changes indices.
    host.style.width = `${width === 240 ? 800 : 240}px`;
    await paint();
    verify();
    expect(selection.toString()).toBe(text);
    expect(metadata()).toEqual(expected);
    expect(recorded).toMatchObject({ available: true, partial: false });
  } finally {
    selection.removeAllRanges();
    recorded.dispose();
    context.dispose();
    host.remove();
  }
});

it('retains the fixed-height transcript preview measurement for long source lines', async () => {
  const path = 'preview.ts';
  const context = makeContractCtx({ width: 240 });
  const reading = await renderAndMeasureUnit(diffUnitDef, {
    kind: 'diff', id: 'preview-wrap-boundary', status: 'done', patches: [patch(path, code)],
  }, context, host => ({
    wrapped: [...host.querySelectorAll<HTMLElement>('[data-patch-row="add"]')]
      .filter(row => row.getBoundingClientRect().height > context.theme.fonts.code.lineHeight + 1).length,
  }));
  expect(reading.dom).toBe(reading.computed);
  expect(reading.inspected.wrapped).toBe(0);
});
