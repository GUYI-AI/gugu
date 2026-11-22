/** @jsxImportSource solid-js */
// The tool diff header draws the edited file's icon; a patch over several files has no one icon.
import { textFilePatch } from '@gugu/session-core/lib';
import { diffUnitDef } from '@session-chat/components/rows/tools/diff/diff.def';
import type { ChatDiff } from '@session-chat/model';
import { expect, it } from 'vitest';
import { makeContractCtx, renderAndMeasureUnit, type ContractInspector } from './contract';

const headerMark: ContractInspector = (host) => {
  const icon = host.querySelector('[data-patch-scope] > svg')?.getAttribute('data-file-icon');
  return { ts: icon === 'ts' ? 1 : 0, unknown: icon === 'unknown' ? 1 : 0 };
};

const oneFile: ChatDiff = { kind: 'diff', id: 'mark-one', status: 'done', patches: [textFilePatch('src/math.ts', 'a', 'b')] };
const twoFiles: ChatDiff = {
  kind: 'diff', id: 'mark-two', status: 'done',
  patches: [{ scope: 'unknown', changes: [{ operation: 'modify', path: 'src/math.ts' }, { operation: 'modify', path: 'README.md' }], patch: null }],
};

it('draws the icon of a one-file patch', async () => {
  const reading = await renderAndMeasureUnit(diffUnitDef, oneFile, makeContractCtx({ width: 600 }), headerMark);
  expect(reading.inspected).toEqual({ ts: 1, unknown: 0 });
});

it('draws the generic mark for a patch over several files', async () => {
  const reading = await renderAndMeasureUnit(diffUnitDef, twoFiles, makeContractCtx({ width: 600 }), headerMark);
  expect(reading.inspected).toEqual({ ts: 0, unknown: 1 });
});
