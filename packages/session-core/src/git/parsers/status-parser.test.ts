import { describe, expect, it } from 'vitest';
import { MAX_STATUS_FILES, StatusParser } from './status-parser';

describe('StatusParser', () => {
  it('ignores later chunks after the cap until reset', () => {
    const parser = new StatusParser();
    parser.update(Array.from({ length: MAX_STATUS_FILES + 1 }, (_, i) => `? f${i}.md\0`).join(''));
    const count = parser.status.length;
    parser.update('? later.md\0');
    expect(parser.status).toHaveLength(count);
    parser.reset();
    parser.update('? fresh.md\0');
    expect(parser.status).toEqual([{ x: '?', y: '?', path: 'fresh.md' }]);
  });
  it('skips optional branch header records before file entries', () => {
    const parser = new StatusParser();
    parser.update('# branch.oid abc\0# branch.head main\0? note.md\0');
    expect(parser.status).toEqual([{ x: '?', y: '?', path: 'note.md' }]);
  });
  const headOid = '1111111111111111111111111111111111111111';
  const indexOid = '2222222222222222222222222222222222222222';

  it('parses porcelain v2 ordinary, untracked, and conflicted entries', () => {
    const parser = new StatusParser();

    parser.update(
      [
        `1 .M N... 100644 100644 100644 ${headOid} ${indexOid} src/foo with spaces.ts\0`,
        '? untracked.ts\0',
        `u UU N... 100644 100644 100644 100644 ${headOid} ${indexOid} 3333333333333333333333333333333333333333 conflict.ts\0`,
      ].join('')
    );

    expect(parser.status).toEqual([
      {
        x: ' ',
        y: 'M',
        path: 'src/foo with spaces.ts',
        headOid,
        indexOid,
      },
      { x: '?', y: '?', path: 'untracked.ts' },
      { x: 'U', y: 'U', path: 'conflict.ts' },
    ]);
  });

  it('parses porcelain v2 rename entries with NUL-separated new and original paths', () => {
    const parser = new StatusParser();

    parser.update(`2 R. N... 100644 100644 100644 ${headOid} ${indexOid} R100 new.ts\0old.ts\0`);

    expect(parser.status).toEqual([
      {
        x: 'R',
        y: ' ',
        rename: 'new.ts',
        path: 'old.ts',
        headOid,
        indexOid,
      },
    ]);
  });

  it('buffers rename entries split between the new and original path fields', () => {
    const parser = new StatusParser();
    const entry = `2 R. N... 100644 100644 100644 ${headOid} ${indexOid} R100 new.ts\0old.ts\0`;
    const split = entry.indexOf('\0') + 1;

    parser.update(entry.slice(0, split));
    expect(parser.status).toEqual([]);

    parser.update(entry.slice(split));
    expect(parser.status).toEqual([
      {
        x: 'R',
        y: ' ',
        rename: 'new.ts',
        path: 'old.ts',
        headOid,
        indexOid,
      },
    ]);
  });

  it('buffers split entries and skips nested git repository directory markers', () => {
    const parser = new StatusParser();

    const entry = `1 .M N... 100644 100644 100644 ${headOid} ${indexOid} src/foo.ts\0`;
    parser.update(entry.slice(0, 35));
    parser.update(entry.slice(35));
    parser.update('? vendor/sub/\0');

    expect(parser.status).toEqual([{ x: ' ', y: 'M', path: 'src/foo.ts', headOid, indexOid }]);
  });

  it('skips ignored entries', () => {
    const parser = new StatusParser();

    parser.update('! ignored.log\0');

    expect(parser.status).toEqual([]);
  });

  it('marks the stream as too large once the status file limit is exceeded', () => {
    const parser = new StatusParser();
    let chunk = '';
    for (let i = 0; i < MAX_STATUS_FILES + 2; i++) {
      chunk += `1 .M N... 100644 100644 100644 ${headOid} ${indexOid} f${i}.ts\0`;
    }

    parser.update(chunk);

    expect(parser.tooManyFiles).toBe(true);
    expect(parser.status.length).toBeGreaterThanOrEqual(MAX_STATUS_FILES);
  });
});
