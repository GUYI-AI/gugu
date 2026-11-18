import { fencedLineMask } from '@gugu/core/shared/markdownFences'

const INLINE_CODE = /((`+)(?!`)[^\n]*?\2(?!`))/

/**
 * Markdown as one line of plain text, for previews (chat list rows and the notifications built from them).
 * Inline code stays exactly as written: it is literal text, and a reference inside it is not a reference.
 * Previews arrive cut at a length limit, so a marker can lose its partner (`**10/27 全天复盘** **凌晨…`);
 * leftover markers outside code are dropped too, not just matched pairs.
 */
export function markdownPlainText(text: string): string {
  return withoutFencedBlocks(text)
    .split(INLINE_CODE)
    .filter((_, index) => index % 3 !== 2)
    .map((part, index) => (index % 2 === 1 ? part : plainSegment(part)))
    .join('')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}

function withoutFencedBlocks(text: string): string {
  const mask = fencedLineMask(text);
  return text.split('\n').filter((_, index) => !mask[index]).join('\n');
}

function replaceInlineLinks(text: string): string {
  const pattern = /(!?)\[([^\]\n]*)\]\(/g;
  let result = '';
  let copied = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index < copied) continue;
    let depth = 1;
    let end = match.index + match[0].length;
    for (; end < text.length && depth > 0; end += 1) {
      if (text[end] === '(') depth += 1;
      else if (text[end] === ')') depth -= 1;
    }
    if (depth !== 0) continue;
    result += text.slice(copied, match.index) + (match[1] ? '' : match[2]);
    copied = end;
  }
  return result + text.slice(copied);
}

function plainSegment(text: string): string {
  const literals: string[] = [];
  const escaped = text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_, char: string) => {
    literals.push(char);
    return `\uE000${literals.length - 1}\uE000`;
  });
  return replaceInlineLinks(escaped)
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]+#+[ \t]*$/gm, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(?<![\w*])(\*|_)(?=\S)([^*_\n]*?\S)\1(?![\w*])/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\uE000(\d+)\uE000/g, (_, index: string) => literals[Number(index)])
}
