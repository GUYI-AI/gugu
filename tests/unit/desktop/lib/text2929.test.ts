// #2929 Product paths: chat list previews, search highlighting and session naming.
import { expect, it } from 'vitest';
import { markdownPlainText } from '../../../../apps/desktop/src/lib/markdownPlainText';
import { excerpt, matchRanges } from '../../../../apps/desktop/src/session/shared/core/search';
import { sessionTitleRequestBody } from '../../../../apps/desktop/src/session/shared/core/sessions/session-title-namer';

it('keeps multi backtick inline code literal',()=>{const text='run ``a`b **literal** [x](y)`` now';expect(markdownPlainText(text)).toBe(text);expect(markdownPlainText('``**literal**``')).toBe('``**literal**``');});

it('keeps escaped Markdown punctuation literal',()=>{expect(markdownPlainText('Use \\*\\*literal\\*\\* and \\[label\\](target)')).toBe('Use **literal** and [label](target)');expect(markdownPlainText('**bold** snake_case')).toBe('bold snake_case');});

it('removes balanced Markdown link destinations',()=>{expect(markdownPlainText('see [Function](https://example.test/wiki/Function_(math)) now')).toBe('see Function now');expect(markdownPlainText('before ![plot](images/plot_(1).png) after')).toBe('before  after');expect(markdownPlainText('[Nested](https://example.test/a_(b_(c)))')).toBe('Nested');});

it('respects Markdown fence lengths',()=>{expect(markdownPlainText('before\n~~~~md\nsecret\n~~~\nstill code\n~~~~\nafter')).toBe('before after');expect(markdownPlainText('before\n````md\nsecret\n```\nstill code\n````\nafter')).toBe('before after');expect(markdownPlainText('```literal```')).toBe('```literal```');});

it('highlights original text after lowercase expansion',()=>{const text='İstanbul docs';const ranges=matchRanges(text,'docs');expect(ranges).toEqual([{start:9,end:13}]);expect(text.slice(ranges[0].start,ranges[0].end)).toBe('docs');expect(matchRanges('İx','i')).toEqual([{start:0,end:1}]);expect(matchRanges('ΟΣ','ος')).toEqual([{start:0,end:2}]);expect(matchRanges('a𐐀b','𐐨')).toEqual([{start:1,end:3}]);});

it('keeps search excerpts on original Unicode boundaries',()=>{const before='İ'.repeat(80)+'😀'.repeat(30);const text=before+'needle '+'z'.repeat(150);expect(excerpt(text,'needle')).toContain('needle');const cut=excerpt('a'.repeat(119)+'😀tail','a');expect(cut).toBe('a'.repeat(119)+'…');const shifted=excerpt('a'.repeat(31)+'😀'+'b'.repeat(29)+'needle'+'z'.repeat(150),'needle');expect(shifted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);});
