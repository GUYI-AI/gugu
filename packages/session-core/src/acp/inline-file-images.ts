/**
 * Pictures placed in a person's words. At send time the composer writes each one where it was put, as an image naming
 * its folder file: `![Image 1](gugu-file://<id>?v=<n>)`. The runtime puts the picture at that place in the prompt;
 * the transcript draws it above the words, the way a chat draws a picture with its caption (`withoutFileImages`).
 */
const FILE_IMAGE = /!\[([^\]]*)\]\((gugu-file:\/\/([^?#)\s]+)[^)\s]*)\)/g;

/** `href` is the whole `gugu-file://<id>?v=<n>` link, the version included. */
export type FileImageLink = { label: string; href: string; itemId: string; index: number; length: number };

export function fileImageLinks(text: string): FileImageLink[] {
  return Array.from(text.matchAll(FILE_IMAGE), (match) => ({ label: match[1], href: match[2], itemId: match[3], index: match.index, length: match[0].length }));
}

/**
 * The words without the pictures `drawn` says are drawn elsewhere, each taken out with the space around it: a chat's
 * caption without its pictures' places (the composer's `withoutInlineImages`). A link to any other picture stays.
 */
export function withoutFileImages(text: string, drawn: (itemId: string) => boolean): string {
  return text.replace(/[ \t]*!\[[^\]]*\]\(gugu-file:\/\/([^?#)\s]+)[^)\s]*\)[ \t]*/g, (link: string, itemId: string, offset: number, whole: string) => {
    if (!drawn(itemId)) return link;
    const before = whole[offset - 1], after = whole[offset + link.length];
    return before === undefined || before === '\n' || after === undefined || after === '\n' ? '' : ' ';
  }).trim();
}
