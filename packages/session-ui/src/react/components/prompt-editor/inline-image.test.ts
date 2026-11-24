import { describe, expect, it } from 'vitest';
import { inlineImageMarker, inlineImageParts, plainTextDoc } from './serialize';

describe('inline image markers', () => {
  it('cut the text at each picture, in order', () => {
    const text = `see ${inlineImageMarker('a')} then ${inlineImageMarker('b')}${inlineImageMarker('c')} done`;
    expect(inlineImageParts(text)).toEqual([
      { text: 'see ' }, { imageId: 'a' }, { text: ' then ' }, { imageId: 'b' }, { imageId: 'c' }, { text: ' done' },
    ]);
  });

  it('restore as image nodes when a draft is written back', () => {
    const doc = plainTextDoc(`x ${inlineImageMarker('a')} y`);
    expect(doc.content[0].content).toEqual([
      { type: 'text', text: 'x ' }, { type: 'inlineImage', attrs: { id: 'a' } }, { type: 'text', text: ' y' },
    ]);
  });
});
