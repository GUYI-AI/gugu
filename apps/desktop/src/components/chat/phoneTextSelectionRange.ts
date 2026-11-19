export interface PhoneTextRange {
  start: number
  end: number
}

/** Offsets stay in UTF-16, the indexing used by DOM ranges, Android and UIKit. */
export function phoneTextWordRange(text: string, offset: number): PhoneTextRange | null {
  if (!text.trim()) return null
  const at = Math.max(0, Math.min(text.length, Math.trunc(Number.isFinite(offset) ? offset : 0)))
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)]
  const nonempty = segments.filter(part => part.segment.trim())
  const distance = (part: typeof nonempty[number]) => Math.max(part.index - at, at - part.index - part.segment.length, 0)
  const part = nonempty.find(candidate => candidate.index <= at && at < candidate.index + candidate.segment.length)
    ?? nonempty.reduce((nearest, candidate) => distance(candidate) < distance(nearest) ? candidate : nearest)
  return { start: part.index, end: part.index + part.segment.length }
}
