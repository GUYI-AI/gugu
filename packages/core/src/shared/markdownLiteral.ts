/**
 * Text placed inside markdown (a link's words, an image's alt, a quote's sender) that reads back as exactly this text.
 *
 * Markdown punctuation is escaped with a backslash, except `[`, `]` and `$`: in gugu's dialect `\[…\]` is LaTeX display
 * math and `$…$` is inline math (markdownMath.mjs), so a backslash-escaped bracket pair would be drawn as a formula.
 * Those three are written as character references, which the parser only ever reads as the plain character.
 */
const BACKSLASHED = /[\\`*_~<>#|&]/g;
const REFERENCED: Record<string, string> = { '[': '&#91;', ']': '&#93;', $: '&#36;' };

export function markdownLiteral(text: string): string {
  return text.replace(BACKSLASHED, '\\$&').replace(/[[\]$]/g, (char) => REFERENCED[char]!);
}

/**
 * The text back from what `markdownLiteral` wrote, for a reader that takes it out of the markdown source by pattern
 * rather than through the parser. Older writers backslash-escaped brackets; those read back too.
 */
export function readMarkdownLiteral(written: string): string {
  return written.replace(/\\([!-/:-@[-`{-~])|&#(91|93|36);/g, (_, escaped?: string, code?: string) =>
    escaped ?? String.fromCharCode(Number(code)));
}
