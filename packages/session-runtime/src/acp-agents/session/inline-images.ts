/**
 * Pictures placed in the person's words. The composer writes each one where it was put, as an image naming its folder
 * file (`![Image 1](gugu-file://<id>?v=<n>)`); the file arrives as an image attachment read from that file (`fileItemId`).
 * Here the words are cut at those places and each picture goes in between, so the agent reads text, picture, text in the
 * order the person wrote them. The marker's own words stay in the text (`[Image 1]`), so "the button in image 2" still
 * has something to point at. A marker whose picture is not sent as an image (a model that takes none) is left as written.
 */

const FILE_IMAGE = /!\[([^\]]*)\]\(gugu-file:\/\/([^?#)\s]+)[^)\s]*\)/g;

export type InlinePromptPart = { text: string } | { image: number };

/** The words cut at their pictures, or null when none of them is a picture sent as an image (keep the usual layout). */
export function inlinePromptParts(text: string, imageOf: (itemId: string) => number | null): InlinePromptPart[] | null {
  const parts: InlinePromptPart[] = [];
  const used = new Set<number>();
  let pending = '';
  let cursor = 0;
  for (const match of text.matchAll(FILE_IMAGE)) {
    const image = imageOf(match[2]);
    if (image === null || used.has(image)) continue;
    used.add(image);
    pending += text.slice(cursor, match.index) + `[${match[1]}]`;
    parts.push({ text: pending }, { image });
    pending = '';
    cursor = match.index + match[0].length;
  }
  if (used.size === 0) return null;
  pending += text.slice(cursor);
  if (pending.trim()) parts.push({ text: pending });
  return parts;
}
