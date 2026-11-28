import { describe, expect, it } from 'vitest';
import { withoutFileImages } from './inline-file-images';

const drawn = (itemId: string) => itemId !== 'other';

describe('withoutFileImages', () => {
  it('takes each drawn picture out of the words with the space around it', () => {
    expect(withoutFileImages('我给你发的第一条消息怎么成空白了，![图 1](gugu-file://a?v=1)', drawn)).toBe('我给你发的第一条消息怎么成空白了，');
    expect(withoutFileImages('![图 1](gugu-file://a?v=1) 看这张', drawn)).toBe('看这张');
    expect(withoutFileImages('before ![图 1](gugu-file://a?v=1) after', drawn)).toBe('before after');
    expect(withoutFileImages('line one\n![图 1](gugu-file://a?v=2)\nline two', drawn)).toBe('line one\n\nline two');
    expect(withoutFileImages('![图 1](gugu-file://a?v=1)![图 2](gugu-file://b?v=1)', drawn)).toBe('');
  });

  it('keeps a link to a picture that is not drawn elsewhere, and other images', () => {
    expect(withoutFileImages('see ![图 1](gugu-file://other?v=1) here', drawn)).toBe('see ![图 1](gugu-file://other?v=1) here');
    expect(withoutFileImages('a ![x](https://example.org/x.png) b', drawn)).toBe('a ![x](https://example.org/x.png) b');
  });
});
