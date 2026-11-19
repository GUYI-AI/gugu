/**
 * Canonical mention grammar shared between the chat composer (write path) and
 * the transcript parser (read path) so neither side can drift from the other.
 *
 * Pure TypeScript — no remark/unified dependencies.
 */

/** Discriminator for the three inline-chip syntax forms. */
export type MentionSyntax = 'at-bare' | 'at-bracket' | 'slash';

/** Semantic category for a mention, mirrors the composer's MentionKind. */
export type MentionKind = 'file' | 'issue' | 'symbol' | 'custom';

/**
 * Pattern source for bare @-mention tokens.
 *
 * Matches word chars, slashes, hyphens, colons, parens, and internal dots.
 * A trailing dot is NOT consumed (sentence-final dot avoidance).
 *
 * Examples matched: @src/auth/jwt.ts  @issue-42  @handleSubmit()  @.gitignore
 *
 * Use as: `new RegExp(AT_BARE_PATTERN, 'g')`
 */
export const AT_BARE_PATTERN = String.raw`@((?:[\w/\-:()]|\.(?=[\w/\-:()]))+)`;

/**
 * Pattern source for /-command tokens.
 *
 * Matches only at line start or after whitespace to avoid matching path
 * separators and URLs (e.g. path/to/file, https://example.com/path).
 *
 * Examples matched: /web  /search-files  /explain
 *
 * Use as: `new RegExp(SLASH_PATTERN, 'g')`
 */
export const SLASH_PATTERN = String.raw`(?:^|(?<=\s))\/([\w-]+)`;

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Make the common agent form `[label](C:\\path with spaces\\file)` valid
 * CommonMark without changing links that are already valid. Bare destinations
 * cannot contain spaces, so remark otherwise leaves this Windows file link as
 * ordinary text and the chat renderer never gets an href to classify.
 */
export function normalizeWindowsMarkdownFileLinks(markdown: string): string {
  let fence: { char: '`' | '~'; length: number } | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = /^ {0,3}([`~]{3,})/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1]!;
        const markerChar = marker[0] as '`' | '~';
        if (!fence) {
          fence = { char: markerChar, length: marker.length };
        } else if (fence.char === markerChar && marker.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      return fence ? line : normalizeWindowsLinksInLine(line);
    })
    .join('\n');
}

function normalizeWindowsLinksInLine(line: string): string {
  let out = '';
  let cursor = 0;
  let codeDelimiter: string | null = null;

  while (cursor < line.length) {
    if (line[cursor] === '`') {
      let end = cursor + 1;
      while (line[end] === '`') end += 1;
      const delimiter = line.slice(cursor, end);
      if (codeDelimiter === null) codeDelimiter = delimiter;
      else if (delimiter === codeDelimiter) codeDelimiter = null;
      out += delimiter;
      cursor = end;
      continue;
    }
    if (codeDelimiter !== null || line[cursor] !== '[') {
      out += line[cursor]!;
      cursor += 1;
      continue;
    }

    const labelEnd = findClosingBracket(line, cursor + 1);
    const destinationStart = labelEnd >= 0 && line[labelEnd + 1] === '(' ? labelEnd + 2 : -1;
    if (destinationStart < 0 || line[destinationStart] === '<') {
      out += line[cursor]!;
      cursor += 1;
      continue;
    }

    const destinationEnd = findClosingParen(line, destinationStart);
    if (destinationEnd < 0) {
      out += line[cursor]!;
      cursor += 1;
      continue;
    }
    const destination = line.slice(destinationStart, destinationEnd);
    if (WINDOWS_DRIVE_PATH.test(destination) && /\s/.test(destination)) {
      out += line.slice(cursor, destinationStart) + `<${destination}>)`;
      cursor = destinationEnd + 1;
    } else {
      out += line.slice(cursor, destinationEnd + 1);
      cursor = destinationEnd + 1;
    }
  }
  return out;
}

function findClosingBracket(line: string, start: number): number {
  let depth = 1;
  for (let i = start; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '[') depth += 1;
    if (line[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

function findClosingParen(line: string, start: number): number {
  let depth = 1;
  for (let i = start; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '(') depth += 1;
    if (line[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Characters that require an angle-bracket URL destination in CommonMark.
 * Bare link destinations forbid spaces and unbalanced parentheses.
 */
const NEEDS_ANGLE = /[\s()]/;

/**
 * A label inside `@[…]`: a lone `]` ends the link text and the whole mention is lost (App 引用 pill 实测 10-14: `a]b`,
 * `图 2]` drew no pill at all), so brackets and backslashes are escaped; remark reads the label back unescaped.
 */
const bracketLabel = (label: string) => label.replace(/[\\[\]]/g, (c) => `\\${c}`);

/**
 * A draft's words, then its pills: a line apart, or a blank line when the words end in a `> ` quote — a quote's
 * last line would otherwise run on into the pills and take them in.
 */
export function draftWithPills(text: string, pills: string): string {
  if (!text || !pills) return text || pills;
  return `${text}${/(^|\n)>[^\n]*$/.test(text) ? '\n\n' : '\n'}${pills}`;
}

/**
 * A cite of working-copy files, as an App's draft names them (`refs`): its words (the selection's `> ` quote), then one
 * @file pill per ref, named by the file and its place (`a.md (Lines 3–4)`). The Files App's cite and the host's file
 * preview both come here.
 */
export function fileCiteDraft(words: string, refs: readonly { file: { id: string }; label?: unknown }[]): string {
  return fileCite(words, refs).draft;
}

/** The same cite in its parts too, for a host that shows it before sending: the words, and each pill's label. */
export function fileCite(words: string, refs: readonly { file: { id: string }; label?: unknown }[]): { draft: string; quote: string; pills: string[] } {
  return pillCite(words, refs.map(({ file, label }) => {
    const name = file.id.replace(/\\/g, '/').split('/').pop() ?? file.id;
    return { label: typeof label === 'string' && label ? `${name} (${label})` : name, target: file.id };
  }));
}

/** A cite whose pills are already named and pointed (a chat folder's files: the folder's name, a `gugu-file://` link). */
export function pillCite(words: string, pills: readonly { label: string; target: string }[]): { draft: string; quote: string; pills: string[] } {
  const quote = words.trim();
  return { draft: draftWithPills(quote, pills.map(pill => stringifyMention({ ...pill, kind: 'file' })).join(' ')), quote, pills: pills.map(pill => pill.label) };
}

/**
 * A file pill's label read back as `fileCite` wrote it: the name, then its place (` (Lines 3–4)`, or ` · 第 4 行` in older
 * messages), the place with its leading space. Every pill that draws a file label cuts it here, so a long name gives way
 * and the place stays whole. A place is the bracket pair that ends the label; a bracket inside a name ends in its extension.
 */
export function fileLabelParts(label: string): { name: string; place: string } {
  const cut = / \([^()]+\)$/.exec(label)?.index ?? label.indexOf(' · ');
  return cut > 0 ? { name: label.slice(0, cut), place: label.slice(cut) } : { name: label, place: '' };
}

/**
 * Produce the canonical text form of a mention for use as the serialized
 * submit/clipboard text.
 *
 * - File and issue mentions with a target: `@[label](target)`. When the target
 *   contains spaces or parentheses (forbidden in bare CommonMark destinations),
 *   it is wrapped in angle brackets: `@[label](<path with spaces>)`. remark
 *   parses both forms to the same link node, recovering the target verbatim.
 * - Agent mentions(`custom`)同样走括号写法:`@[Claude 1](aid:<Agent ID>)`。裸写法装不下它 ——
 *   agent 的名字必然带空格(`Claude 1`),而裸 token 的字符集不吃空格,`@Claude 1` 只会被解析成
 *   `@Claude`。括号写法让**人看到名字、机器拿到 Agent ID**,一段文字同时满足两边
 *   (owner 2026-09-16 拍板的形状)。
 * - Everything else: `@${target ?? label}` (bare form).
 */
export function stringifyMention(m: {
  label: string;
  target?: string;
  kind: MentionKind | null;
}): string {
  if (m.kind === 'custom' && m.target && m.target !== m.label) {
    const dest = NEEDS_ANGLE.test(m.target) ? `<${m.target}>` : m.target;
    return `@[${bracketLabel(m.label)}](${dest})`;
  }
  if ((m.kind === 'file' || m.kind === 'issue') && m.target) {
    const dest = NEEDS_ANGLE.test(m.target) ? `<${m.target}>` : m.target;
    return `@[${bracketLabel(m.label)}](${dest})`;
  }
  return `@${m.target ?? m.label}`;
}
