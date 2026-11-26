import { describe, expect, it } from 'vitest';
import { inlinePromptParts } from './inline-images';

const ids: Record<string, number> = { 'aaa': 0, 'bbb': 1 };
const imageOf = (itemId: string) => ids[itemId] ?? null;

describe('inlinePromptParts', () => {
  it('puts each picture at its place in the words, keeping its label', () => {
    expect(inlinePromptParts('look ![Image 1](gugu-file://aaa?v=1) and ![Image 2](gugu-file://bbb?v=3) ok', imageOf)).toEqual([
      { text: 'look [Image 1]' }, { image: 0 }, { text: ' and [Image 2]' }, { image: 1 }, { text: ' ok' },
    ]);
  });

  it('keeps the usual layout when no marker is a picture sent as an image', () => {
    expect(inlinePromptParts('plain words', imageOf)).toBeNull();
    expect(inlinePromptParts('![x](gugu-file://zzz?v=1)', imageOf)).toBeNull();
  });

  it('leaves a marker whose picture is not sent in the text', () => {
    expect(inlinePromptParts('![a](gugu-file://zzz?v=1) ![b](gugu-file://aaa?v=1)', imageOf)).toEqual([
      { text: '![a](gugu-file://zzz?v=1) [b]' }, { image: 0 },
    ]);
  });
});
