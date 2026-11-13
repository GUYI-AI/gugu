// A group's default face: a ring in one of eight colours around a group mark, or around up to two short lines of
// text the group chose. Every surface draws a group from this one description; a picture the group uploaded
// replaces it whole.

export const GROUP_AVATAR_COLORS = ['#3370FF', '#7F3BF5', '#04B49C', '#2EA121', '#8FAC02', '#DC9B04', '#DE7802', '#F01D94'] as const

/** The disc of a face saved as a picture: a picture cannot follow the theme, so it is white on every surface. */
export const GROUP_AVATAR_PICTURE_FILL = '#ffffff'

/** The colour a group gets before anyone picks one: fixed by its id, so every member and surface sees the same. */
export function groupAvatarColor(chatId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < chatId.length; i++) hash = Math.imul(hash ^ chatId.charCodeAt(i), 0x01000193)
  return GROUP_AVATAR_COLORS[(hash >>> 0) % GROUP_AVATAR_COLORS.length]
}

// A line holds two full-width characters or four half-width ones; a face holds two lines.
const LINE_UNITS = 4
const MAX_LINES = 2
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const unitsOf = (grapheme: string) => (grapheme.codePointAt(0)! >= 0x2e80 ? 2 : 1)

/** The lines a face shows for `text`: what does not fit in two lines is dropped. */
export function groupAvatarTextLines(text: string): string[] {
  const lines: string[] = []
  let line = ''
  let used = 0
  for (const { segment } of segmenter.segment(text.trim())) {
    if (/\s/.test(segment) && !line) continue
    const units = unitsOf(segment)
    if (used + units > LINE_UNITS) {
      lines.push(line.trimEnd())
      if (lines.length === MAX_LINES) return lines
      line = ''
      used = 0
      if (/\s/.test(segment)) continue
    }
    line += segment
    used += units
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines
}

const SIZE = 208
const STROKE = 6.5
// Type size steps down with the number of characters shown (on the 208 square).
const fontSizeFor = (count: number) => (count <= 1 ? 116 : count === 2 ? 92 : count <= 4 ? 72 : 60)
const FONT = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', 'Noto Sans CJK SC', sans-serif"
const GROUP_MARK = '<circle cx="90" cy="82" r="21"/><path d="M52 146c0-21 17-34 38-34s38 13 38 34c0 4-3 7-7 7H59c-4 0-7-3-7-7z"/>'
  + '<circle cx="136" cy="92" r="15"/><path d="M137 116c13 2 23 12 23 28 0 4-3 7-7 7h-17c1-2 1-4 1-6 0-11-5-20-12-27 4-2 8-2 12-2z"/>'

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/**
 * The face as one SVG: `fill` is the disc behind the ring (a CSS colour, so a live face can follow the theme); `px` gives
 * it a size of its own, for drawing it as an image rather than into a sized box; `label` names it for a screen reader.
 */
export function groupAvatarSvg({ color, text = '', fill, px, label }: { color: string; text?: string; fill: string; px?: number; label?: string }): string {
  const lines = groupAvatarTextLines(text)
  const count = lines.reduce((sum, line) => sum + Array.from(segmenter.segment(line)).length, 0)
  const fontSize = fontSizeFor(count)
  const pitch = fontSize * 1.13
  const first = SIZE / 2 - (pitch * (lines.length - 1)) / 2
  const inner = lines.length
    ? `<g fill="${color}" font-family="${FONT}" font-size="${fontSize}" font-weight="500" text-anchor="middle">${lines.map((line, index) =>
      `<text x="${SIZE / 2}" y="${first + pitch * index}" dominant-baseline="central">${escapeXml(line)}</text>`).join('')}</g>`
    : `<g fill="${color}">${GROUP_MARK}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img"${label ? ` aria-label="${escapeXml(label)}"` : ''} viewBox="0 0 ${SIZE} ${SIZE}" width="${px ?? '100%'}" height="${px ?? '100%'}">`
    + `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${(SIZE - STROKE) / 2}" fill="${fill}" stroke="${color}" stroke-width="${STROKE}"/>${inner}</svg>`
}
