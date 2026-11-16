// #2929 Product paths: chat list previews, search highlighting and session naming.
import { expect, it } from 'vitest';
import { markdownPlainText } from '../../../../apps/desktop/src/lib/markdownPlainText';
import { excerpt, matchRanges } from '../../../../apps/desktop/src/session/shared/core/search';
import { sessionTitleRequestBody } from '../../../../apps/desktop/src/session/shared/core/sessions/session-title-namer';

it('keeps multi backtick inline code literal',()=>{const text='run ``a`b **literal** [x](y)`` now';expect(markdownPlainText(text)).toBe(text);expect(markdownPlainText('``**literal**``')).toBe('``**literal**``');});

it('keeps escaped Markdown punctuation literal',()=>{expect(markdownPlainText('Use \\*\\*literal\\*\\* and \\[label\\](target)')).toBe('Use **literal** and [label](target)');expect(markdownPlainText('**bold** snake_case')).toBe('bold snake_case');});

it('removes balanced Markdown link destinations',()=>{expect(markdownPlainText('see [Function](https://example.test/wiki/Function_(math)) now')).toBe('see Function now');expect(markdownPlainText('before ![plot](images/plot_(1).png) after')).toBe('before  after');expect(markdownPlainText('[Nested](https://example.test/a_(b_(c)))')).toBe('Nested');});

it('respects Markdown fence lengths',()=>{expect(markdownPlainText('before\n~~~~md\nsecret\n~~~\nstill code\n~~~~\nafter')).toBe('before after');expect(markdownPlainText('before\n````md\nsecret\n```\nstill code\n````\nafter')).toBe('before after');expect(markdownPlainText('```literal```')).toBe('```literal```');});
