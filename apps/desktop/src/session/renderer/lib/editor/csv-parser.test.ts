import { describe, expect, it } from 'vitest';
import { MAX_PREVIEW_COLUMNS, MAX_PREVIEW_ROWS, parseCsv } from './csv-parser';

describe('parseCsv', () => {
  it('parses simple comma-separated rows', () => {
    expect(parseCsv('id,name\n1,Ada\n2,Grace').rows).toEqual([
      ['id', 'name'],
      ['1', 'Ada'],
      ['2', 'Grace'],
    ]);
  });

  it('handles quoted commas, escaped quotes, and quoted newlines', () => {
    expect(parseCsv('id,note\n1,"hello, world"\n2,"said ""hi"""\n3,"multi\nline"').rows).toEqual([
      ['id', 'note'],
      ['1', 'hello, world'],
      ['2', 'said "hi"'],
      ['3', 'multi\nline'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('id,name\r\n1,Ada\r\n').rows).toEqual([
      ['id', 'name'],
      ['1', 'Ada'],
    ]);
  });

  it('counts discarded multiline fields without retaining their text', () => {
    const rows = Array.from({ length: MAX_PREVIEW_ROWS }, (_, index) => `row-${index}`);
    const parsed = parseCsv(rows.join('\n') + '\n"large\nfield","escaped ""quote"""\nlast');
    expect(parsed.rows).toHaveLength(MAX_PREVIEW_ROWS);
    expect(parsed.rows.at(-1)).toEqual([`row-${MAX_PREVIEW_ROWS - 1}`]);
    expect(parsed.truncatedRows).toBe(2);
    expect(parsed.truncatedColumns).toBe(0);
  });

  it('keeps row framing and empty quoted cells after the column limit', () => {
    const visible = Array.from({ length: MAX_PREVIEW_COLUMNS }, (_, index) => `col-${index}`);
    const parsed = parseCsv(visible.join(',') + ',"a,b\nline",,""\nnext,row');
    expect(parsed.rows).toEqual([visible, ['next', 'row']]);
    expect(parsed.truncatedColumns).toBe(3);
    expect(parsed.truncatedRows).toBe(0);
  });
});
