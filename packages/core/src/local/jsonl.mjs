import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'

// JSONL ends only at LF; CR is removed only immediately before LF or EOF.
class LfFrames {
  decoder = new StringDecoder('utf8')
  parts = []
  write(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const lines = []
    let start = 0
    let end
    while ((end = text.indexOf('\n', start)) !== -1) {
      this.parts.push(text.slice(start, end))
      const line = this.parts.join('')
      this.parts = []
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line)
      start = end + 1
    }
    if (start < text.length) this.parts.push(text.slice(start))
    return lines
  }
  end() {
    const remainder = this.decoder.end()
    if (remainder) this.parts.push(remainder)
    const line = this.parts.join('')
    this.parts = []
    return line ? [line.endsWith('\r') ? line.slice(0, -1) : line] : []
  }
}

/** Callback/event form for protocol pipes. Closing detaches readers without owning the input. */
export function createJsonlReader({ input, onLine, onClose = () => {}, onError = () => {} }) {
  const frames = new LfFrames()
  const reader = new EventEmitter()
  let closed = false
  if (onLine) reader.on('line', onLine)
  const emit = (lines) => {
    for (const line of lines) {
      if (closed) break
      reader.emit('line', line)
    }
  }
  const data = (chunk) => emit(frames.write(chunk))
  const close = () => {
    if (closed) return
    closed = true
    input.off('data', data)
    input.off('end', end)
    input.off('error', error)
    frames.parts = []
    onClose()
    reader.emit('close')
  }
  const end = () => { emit(frames.end()); close() }
  const error = (cause) => { try { onError(cause) } finally { close() } }
  Object.assign(reader, { close, pause: () => input.pause(), resume: () => input.resume() })
  input.on('data', data)
  input.once('end', end)
  input.once('error', error)
  return reader
}

/** Backpressured file form; breaking also returns the underlying Readable iterator. */
export async function* readJsonlLines(input) {
  const frames = new LfFrames()
  for await (const chunk of input) yield* frames.write(chunk)
  yield* frames.end()
}

export function jsonlParseError(source, line) {
  const bytes = Buffer.from(line)
  return new Error(
    `Invalid JSONL from ${source}: bytes=${bytes.length} headHex=${bytes.subarray(0, 80).toString('hex')} tailHex=${bytes.subarray(-80).toString('hex')}`,
  )
}
