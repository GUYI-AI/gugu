/**
 * Pictures placed in a person's words. At send time the composer writes each one where it was put, as an image naming
 * its folder file: `![Image 1](gugu-file://<id>?v=<n>)`. The runtime puts the picture at that place in the prompt;
 * the renderer draws a chip there wherever it shows the words.
 */
const FILE_IMAGE = /!\[([^\]]*)\]\((gugu-file:\/\/([^?#)\s]+)[^)\s]*)\)/g;

/** `href` is the whole `gugu-file://<id>?v=<n>` link, the version included. */
export type FileImageLink = { label: string; href: string; itemId: string; index: number; length: number };

export function fileImageLinks(text: string): FileImageLink[] {
  return Array.from(text.matchAll(FILE_IMAGE), (match) => ({ label: match[1], href: match[2], itemId: match[3], index: match.index, length: match[0].length }));
}
