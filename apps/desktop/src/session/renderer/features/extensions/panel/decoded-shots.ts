/**
 * Featured pictures decoded in this run, the Image kept: a card mounting again draws the same picture at once (❌ decoding it
 * again and showing nothing for a few frames). A picture not decoded is not put on screen. Not kept across restarts (the
 * market's first screen is, without pictures: market-replicas.ts `marketShelf`).
 */
const decoded = new Map<string, HTMLImageElement>();

export const isDecoded = (src: string) => decoded.has(src);

export async function decodeShot(src: string): Promise<void> {
  if (decoded.has(src)) return;
  const image = new window.Image();
  image.src = src;
  await image.decode();
  decoded.set(src, image);
}
