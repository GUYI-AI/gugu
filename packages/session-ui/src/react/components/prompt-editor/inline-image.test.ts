import { describe, expect, it } from 'vitest';
import { inlineImageMarker, inlineImageParts, plainTextDoc, withoutInlineImages } from './serialize';

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

  it('leave the words alone when the pictures go beside them', () => {
    const m = inlineImageMarker;
    expect(withoutInlineImages(`Compare ${m('a')} with ${m('b')} please`)).toBe('Compare with please');
    expect(withoutInlineImages(`${m('a')} ${m('b')}\nsee  this ${m('c')}`)).toBe('\nsee  this');
  });
});
