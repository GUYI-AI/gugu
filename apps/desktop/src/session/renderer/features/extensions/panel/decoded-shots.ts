/** Featured pictures decoded in this run (Image kept): a remounted card draws at once (❌ blank frames while decoding). */
const decoded = new Map<string, HTMLImageElement>();

export const isDecoded = (src: string) => decoded.has(src);

export async function decodeShot(src: string): Promise<void> {
  if (decoded.has(src)) return;
  const image = new window.Image();
  image.src = src;
  await image.decode();
  decoded.set(src, image);
}
