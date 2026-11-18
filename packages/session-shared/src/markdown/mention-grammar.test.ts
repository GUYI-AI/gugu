import { describe, expect, it } from 'vitest';
import { fileCite, fileLabelParts } from './mention-grammar';

describe('fileLabelParts reads a file pill label back as fileCite wrote it', () => {
  it.each([
    ['notes.md (Lines 3–4)', 'notes.md', ' (Lines 3–4)'],
    ['notes.md (第 10–11 行)', 'notes.md', ' (第 10–11 行)'],
    ['notes.md · 第 4 行', 'notes.md', ' · 第 4 行'],
    ['a (1).md', 'a (1).md', ''],
    ['报告 (终稿).md (Line 2)', '报告 (终稿).md', ' (Line 2)'],
    ['notes.md', 'notes.md', ''],
  ])('%s', (label, name, place) => {
    expect(fileLabelParts(label)).toEqual({ name, place });
  });

  it('is the inverse of fileCite', () => {
    const { pills } = fileCite('', [{ file: { id: 'docs/a (1).md' }, label: 'Lines 3–4' }, { file: { id: 'docs/a (1).md' } }]);
    expect(pills.map(fileLabelParts)).toEqual([{ name: 'a (1).md', place: ' (Lines 3–4)' }, { name: 'a (1).md', place: '' }]);
  });
});
