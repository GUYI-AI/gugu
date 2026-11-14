// A group's default face (a project's too: a project is its group): a circle outlined in one of eight quiet
// colours around the first characters of its name, or around a group mark when it has no name. Every surface draws it
// from this one description; a picture the group uploaded replaces it whole.

/** Eight colours, each a theme token (tokens.css `--group-face-1` … `--group-face-8`): ink with a little hue, lighter on the dark theme. */
const COLOR_COUNT = 8
export const groupAvatarThemeColor = (index: number) => `var(--group-face-${index + 1})`

/** Which of the colours a group gets: fixed by its id, so every member and surface sees the same. */
export function groupAvatarColorIndex(chatId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < chatId.length; i++) hash = Math.imul(hash ^ chatId.charCodeAt(i), 0x01000193)
  return (hash >>> 0) % COLOR_COUNT
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** At most two visible graphemes; multiword English names use the first two initials. */
export function groupAvatarDefaultText(name: string): string {
  const trimmed = name.trim()
  const words = trimmed.split(/\s+/)
  if (words.length > 1 && /^[\x20-\x7e]+$/.test(trimmed) && words.every((word) => /^[A-Za-z]/.test(word))) {
    return words.slice(0, 2).map((word) => word[0]!.toUpperCase()).join('')
  }
  return Array.from(segmenter.segment(trimmed), ({ segment }) => segment)
    .filter((grapheme) => !/^\s+$/.test(grapheme)).slice(0, 2).join('')
}

/** The shared face always uses one line, even when called directly with a full name. */
export function groupAvatarTextLines(text: string): string[] {
  const shown = groupAvatarDefaultText(text)
  return shown ? [shown] : []
}

const SIZE = 208
const STROKE = 6.5
// Keep the existing text/mark threshold; two characters fit on one readable line at every text size.
const TEXT_FROM_PX = 24
// Color-emoji fallback fonts have wider advances and taller glyph boxes than the text face.
const fontSizeFor = (text: string, count: number) => /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(text)
  ? (count === 1 ? 76 : 50) : (count === 1 ? 116 : 80)
const FONT = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', 'Noto Sans CJK SC', sans-serif"
const GROUP_MARK = '<circle cx="90" cy="82" r="21"/><path d="M52 146c0-21 17-34 38-34s38 13 38 34c0 4-3 7-7 7H59c-4 0-7-3-7-7z"/>'
  + '<circle cx="136" cy="92" r="15"/><path d="M137 116c13 2 23 12 23 28 0 4-3 7-7 7h-17c1-2 1-4 1-6 0-11-5-20-12-27 4-2 8-2 12-2z"/>'

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/**
 * The face as one SVG. `fill` is the surface inside the outline (a CSS colour, so a live face can follow the theme);
 * `px` keeps the outline at least a pixel and a half wide, and uses the group mark below the text threshold.
 * `label` names it for a screen reader.
 */
export function groupAvatarSvg({ color, text = '', fill, px, label }: { color: string; text?: string; fill: string; px: number; label?: string }): string {
  const lines = px < TEXT_FROM_PX ? [] : groupAvatarTextLines(text)
  const count = lines.reduce((sum, line) => sum + Array.from(segmenter.segment(line)).length, 0)
  const fontSize = fontSizeFor(lines.join(''), count)
  const stroke = Math.max(STROKE, (SIZE / px) * 1.5)
  const inner = lines.length
    ? `<g fill="${color}" font-family="${FONT}" font-size="${fontSize}" font-weight="500" text-anchor="middle">${lines.map((line) =>
      `<text x="${SIZE / 2}" y="${SIZE / 2}" dominant-baseline="central">${escapeXml(line)}</text>`).join('')}</g>`
    : `<g fill="${color}">${GROUP_MARK}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img"${label ? ` aria-label="${escapeXml(label)}"` : ''} viewBox="0 0 ${SIZE} ${SIZE}" width="100%" height="100%">`
    + `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${(SIZE - stroke) / 2}" fill="${fill}" stroke="${color}" stroke-width="${stroke}"/>${inner}</svg>`
}
