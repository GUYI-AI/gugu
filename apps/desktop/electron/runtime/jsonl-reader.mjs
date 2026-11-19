import { StringDecoder } from 'node:string_decoder'

// JSONL frames end only at LF. readline also splits valid JSON strings at U+2028/U+2029.
export function createJsonlReader({ input, onLine, onClose = () => {}, onError = () => {} }) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let closed = false
  const emit = (line) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  const data = (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let end
    while (!closed && (end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      emit(line)
    }
  }
  const close = () => {
    if (closed) return
    closed = true
    input.off('data', data)
    input.off('end', end)
    input.off('error', error)
    buffer = ''
    onClose()
  }
  const end = () => {
    buffer += decoder.end()
    if (buffer) emit(buffer)
    close()
  }
  const error = (cause) => { onError(cause); close() }
  input.on('data', data)
  input.once('end', end)
  input.once('error', error)
  return { close, pause: () => input.pause(), resume: () => input.resume() }
}

export function jsonlParseError(source, line) {
  const bytes = Buffer.from(line)
  return new Error(
    `Invalid JSONL from ${source}: bytes=${bytes.length} headHex=${bytes.subarray(0, 80).toString('hex')} tailHex=${bytes.subarray(-80).toString('hex')}`,
  )
}
