import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createJsonlReader, readJsonlLines } from '../../packages/core/src/local/jsonl.mjs'

const records = [{ id: 1, result: '回包\u2028中文\u2029🙂\r内嵌' }, { method: 'delta', params: { text: '通知\u2028\u2029' } }]
describe('shared LF JSONL framing', () => {
  it('preserves response/notification strings across UTF-8 chunks, CRLF and an unterminated tail', async () => {
    const wire = Buffer.from(records.map(row => JSON.stringify(row)).join('\r\n'))
    const chunks = [...wire].map(byte => Buffer.from([byte]))
    const pipe = new PassThrough(), seen: unknown[] = []
    const closed = new Promise<void>(resolve => createJsonlReader({ input: pipe,
      onLine: line => seen.push(JSON.parse(line)), onClose: resolve }))
    for (const chunk of chunks) pipe.write(chunk)
    pipe.end()
    await closed
    expect(seen).toEqual(records)
    const history = []
    for await (const line of readJsonlLines(Readable.from(chunks))) history.push(JSON.parse(line))
    expect(history).toEqual(records)
  })
  it('does not invent a final empty record and preserves actual blank records', async () => {
    const lines = []
    for await (const line of readJsonlLines(Readable.from(['\n{}\r\n']))) lines.push(line)
    expect(lines).toEqual(['', '{}'])
  })
  it('honors an early protocol close inside a chunk and detaches input listeners', () => {
    const pipe = new PassThrough(), seen: string[] = []
    let closes = 0
    const reader = createJsonlReader({ input: pipe, onClose: () => { closes++ } })
    reader.on('line', line => { seen.push(line); reader.close() })
    pipe.write('{}\n{"mustNotRun":true}\n')
    reader.close()
    pipe.end()
    expect(seen).toEqual(['{}'])
    expect(closes).toBe(1)
    expect(pipe.listenerCount('data')).toBe(0)
    expect(pipe.listenerCount('end')).toBe(0)
    expect(pipe.listenerCount('error')).toBe(0)
  })
  it('returns the underlying stream when a capped history scan stops early', async () => {
    let returned = false
    const source = Readable.from((async function* () {
      try { yield '{}\n{}\n'; yield '{"mustNotRead":true}\n' }
      finally { returned = true }
    })())
    for await (const line of readJsonlLines(source)) { expect(line).toBe('{}'); break }
    expect(source.destroyed).toBe(true)
    // Readable may settle its producer return in the next microtask.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(returned).toBe(true)
  })
  it('reports stream errors and closes once without converting them into successful EOF', async () => {
    const failure = new Error('read failed'), pipe = new PassThrough()
    const errors: Error[] = []
    await new Promise<void>(resolve => {
      createJsonlReader({ input: pipe, onError: error => errors.push(error), onClose: resolve })
      pipe.destroy(failure)
    })
    expect(errors).toEqual([failure])
    const source = Readable.from((async function* () { yield '{}\n'; throw failure })())
    await expect((async () => { for await (const line of readJsonlLines(source)) { JSON.parse(line) } })()).rejects.toBe(failure)
  })
})
