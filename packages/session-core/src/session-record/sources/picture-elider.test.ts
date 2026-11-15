import { describe, expect, it } from 'vitest';
import { PictureElider, elidedBytes, readElidedPicture } from './picture-elider';

const BIG = 'Q'.repeat(10) + 'A'.repeat(70 * 1024) + 'xyz/+=' + 'Z'.repeat(40);
const lines = [
  `{"type":"x","text":"héllo 中文"}`,
  `{"image_url":"data:image/png;base64,${BIG}"}`,
  `{"source":{"type":"base64","media_type":"image/png","data":"${BIG}B"}}`,
  `{"image_url":"data:image/png;base64,short"}`,
  `{"text":"data:x;base64,${'A'.repeat(100)}\\n not a picture"}`,
];
const record = lines.join('\n') + '\n';
const bytes = Buffer.from(record, 'utf8');

/** Feed `record` in pieces of `size` characters. */
function run(size: number) {
  const elider = new PictureElider();
  elider.restart(0);
  let out = '';
  for (let at = 0; at < record.length; at += size) out += elider.write(record.slice(at, at + size));
  return out;
}

describe('picture elider', () => {
  it.each([1, 7, 1000, 64 * 1024, 1 << 20])('leaves long pictures in the record by their place, read %i characters at a time', (size) => {
    const out = run(size).split('\n');
    expect([out[0], out[3], out[4]]).toEqual([lines[0], lines[3], lines[4]]);
    const places = [out[1], out[2]].map((line) => readElidedPicture(/(!gugu-elided:[^"]*)"/.exec(line)![1])!);
    expect(places.map((place) => bytes.subarray(place.start, place.start + place.chars).toString('latin1'))).toEqual([BIG, `${BIG}B`]);
    expect(places.map((place) => [place.head, place.tail])).toEqual([[BIG.slice(0, 32), BIG.slice(-32)], [BIG.slice(0, 32), `${BIG}B`.slice(-32)]]);
    // The record bytes stand where they were: each line's offset is recovered from what was passed on.
    expect(out.reduce((total, line) => total + Buffer.byteLength(line, 'utf8') + 1 + elidedBytes(line), 0) - 1).toBe(bytes.length);
  });

  it('starts over at a new read', () => {
    const elider = new PictureElider();
    elider.restart(0);
    expect(elider.write(`{"a":"data:x;base64,${'A'.repeat(70 * 1024)}`)).toBe('{"a":"data:x;base64,');
    elider.restart(500);
    expect(elider.write('{"b":1}\n')).toBe('{"b":1}\n');
  });
});
