/** @jsxImportSource solid-js */
// The tool diff header draws the edited file's family mark; a patch over several files has no one family.
import { textFilePatch } from '@gugu/session-core/lib';
import { FILE_MARKS } from '@gugu/session-shared/file-marks';
import { diffUnitDef } from '@session-chat/components/rows/tools/diff/diff.def';
import type { ChatDiff } from '@session-chat/model';
import { expect, it } from 'vitest';
import { makeContractCtx, renderAndMeasureUnit, type ContractInspector } from './contract';

/** The glyph a `FileMark` of this family draws, as the DOM writes it back. */
function familyGlyph(family: keyof typeof FILE_MARKS): string {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.innerHTML = FILE_MARKS[family].glyph;
  return svg.innerHTML;
}

const headerMark: ContractInspector = (host) => {
  const glyph = host.querySelector('[data-patch-scope] > svg')?.innerHTML;
  return { code: glyph === familyGlyph('code') ? 1 : 0, other: glyph === familyGlyph('other') ? 1 : 0 };
};

const oneFile: ChatDiff = { kind: 'diff', id: 'mark-one', status: 'done', patches: [textFilePatch('src/math.ts', 'a', 'b')] };
const twoFiles: ChatDiff = {
  kind: 'diff', id: 'mark-two', status: 'done',
  patches: [{ scope: 'unknown', changes: [{ operation: 'modify', path: 'src/math.ts' }, { operation: 'modify', path: 'README.md' }], patch: null }],
};

it('draws the family mark of a one-file patch', async () => {
  const reading = await renderAndMeasureUnit(diffUnitDef, oneFile, makeContractCtx({ width: 600 }), headerMark);
  expect(reading.inspected).toEqual({ code: 1, other: 0 });
});

it('draws the generic mark for a patch over several files', async () => {
  const reading = await renderAndMeasureUnit(diffUnitDef, twoFiles, makeContractCtx({ width: 600 }), headerMark);
  expect(reading.inspected).toEqual({ code: 0, other: 1 });
});
