/** UTF-16 ranges share the same indexing as DOM, Android spans and UIKit attributed strings. */
export interface NativeRichColor { red: number; green: number; blue: number; alpha: number }
export interface NativeRichRun {
  start: number
  end: number
  fontSize: number
  weight: number
  italic: boolean
  underline?: boolean
  monospace: boolean
  color: NativeRichColor
  background?: NativeRichColor
}
export interface NativeRichParagraph {
  start: number
  end: number
  lineHeight: number
  before: number
  after: number
  indent: number
  firstLineIndent: number
  marker?: string
  tabWidth?: number
}
export interface NativeRichBlock {
  start: number
  end: number
  background: NativeRichColor
  insetLeft: number
  insetRight: number
  paddingTop: number
  paddingBottom: number
  radius: number
  trailingSpacing: number
}
export interface NativeRichText {
  text: string
  start: number
  end: number
  runs: NativeRichRun[]
  paragraphs: NativeRichParagraph[]
  blocks: NativeRichBlock[]
}

/** List markers are real copied text. Remap the word and every styling range in one operation. */
export function insertNativeListMarkers(snapshot: NativeRichText): NativeRichText {
  const edits = snapshot.paragraphs.filter(p => p.marker).map(p => ({ at: p.start, value: `${p.marker}\t` })).sort((a, b) => a.at - b.at)
  const offset = (at: number, boundary: 'start' | 'end' = 'start') => at + edits.reduce((n, edit) => n + ((edit.at < at || (boundary === 'start' && edit.at === at)) ? edit.value.length : 0), 0)
  let text = snapshot.text
  for (const edit of [...edits].reverse()) text = text.slice(0, edit.at) + edit.value + text.slice(edit.at)
  return { ...snapshot, text, start: offset(snapshot.start), end: offset(snapshot.end, 'end'),
    runs: snapshot.runs.map(run => ({ ...run, start: offset(run.start), end: offset(run.end, 'end') })),
    paragraphs: snapshot.paragraphs.map(p => ({ ...p, start: offset(p.start) - (p.marker ? `${p.marker}\t`.length : 0), end: offset(p.end, 'end') })),
    blocks: snapshot.blocks.map(block => ({ ...block, start: offset(block.start), end: offset(block.end, 'end') })),
  }
}
