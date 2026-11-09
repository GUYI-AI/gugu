import { open, statfs, unlink } from 'node:fs/promises'
import { randomInt } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { assertAcceptanceScope, LEGACY_MAX_BYTES } from './native-history-safety.mts'

export type Provider = 'claude' | 'codex'
export type FixtureKind = 'sparse-io' | 'valid-jsonl' | 'legacy-giant'
export const VISIBLE_MARKER = 'RECENT-2062: 中文、emoji 🐾、quote "、escape \\'
function record(provider: Provider, id: number, text: string, elapsed = 0): string {
  const timestamp = new Date(Date.UTC(2026, 0, 1) + elapsed).toISOString()
  return JSON.stringify(provider === 'claude'
    ? { type: 'user', uuid: `synthetic-${id}`, parentUuid: null, timestamp, message: { role: 'user', content: text } }
    : { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n'
}
/** Sparse holes contain NULs, so sparse-io is deliberately NOT a valid import corpus. */
export async function createHistoryFixture(path: string, bytes: number, kind: FixtureKind, provider: Provider) {
  if (!Number.isSafeInteger(bytes) || bytes < 4096) throw new Error('Invalid fixture size')
  if (bytes >= LEGACY_MAX_BYTES) await assertAcceptanceScope(process.env.GUGU_ACCEPTANCE_HOST || '')
  const space = await statfs(dirname(path))
  const needed = kind === 'sparse-io' ? 1024 ** 2 : bytes + 1024 ** 2
  if (Number(space.bavail) * Number(space.bsize) < needed * 1.25) throw new Error('Insufficient admitted disk headroom')
  const file = await open(path, 'wx')
  let position = 0
  let records = 0
  async function write(data: Uint8Array) {
    let offset = 0
    while (offset < data.length) {
      const { bytesWritten } = await file.write(data, offset, data.length - offset, position)
      if (!bytesWritten) throw new Error('Fixture write made no progress')
      offset += bytesWritten
      position += bytesWritten
    }
  }
  async function writeGiant(end: number) {
    const head = provider === 'claude'
      ? `{"type":"user","uuid":"giant-${records}","message":{"role":"user","content":"`
      : `{"type":"response_item","payload":{"type":"function_call_output","call_id":"giant-${records}","output":"`
    await write(Buffer.from(head))
    const close = Buffer.from('"}}\n')
    const block = Buffer.alloc(256 * 1024, 120)
    while (position < end - close.length) await write(block.subarray(0, Math.min(block.length, end - close.length - position)))
    await write(close)
    records++
  }
  const tail = Buffer.from(record(provider, 1_000_000_000, VISIBLE_MARKER, 100 * 3600_000))
  try {
    if (kind === 'sparse-io') {
      await file.truncate(bytes)
      await write(Buffer.from('POISON_PREFIX_MUST_NOT_BE_READ\n'))
      position = bytes - tail.length - 1
      await write(Buffer.from('\n'))
      await write(tail)
    } else if (kind === 'legacy-giant') {
      // The adapter receives only the path. Do not publish this unknown record start as a locator.
      await write(Buffer.from(record(provider, records++, 'older readable record ' + 'x'.repeat(randomInt(256, 2048)))))
      await writeGiant(bytes)
    } else {
      const end = bytes - tail.length
      const giantBytes = Math.min(600 * 1024 ** 2, Math.floor(bytes / 8))
      for (let giant = 0; giant < 2; giant++) await writeGiant(position + giantBytes)
      while (position < end) {
        const lines: string[] = []
        let batchBytes = 0
        while (batchBytes < 512 * 1024) {
          const line = record(provider, records, 'x'.repeat(8192), Math.floor((position + batchBytes) / end * 100 * 3600_000))
          if (position + batchBytes + Buffer.byteLength(line) > end) break
          lines.push(line)
          batchBytes += Buffer.byteLength(line)
          records++
        }
        if (lines.length) await write(Buffer.from(lines.join('')))
        else { await write(Buffer.alloc(end - position, 32)); break }
      }
      await write(tail)
      records++
    }
    await file.sync()
    const stats = await file.stat()
    return { bytes: stats.size, allocatedBytes: stats.blocks * 512, records, kind, provider,
      validJsonl: kind !== 'sparse-io', giantRecords: kind === 'sparse-io' ? 0 : kind === 'legacy-giant' ? 1 : 2, simulatedHours: kind === 'valid-jsonl' ? 100 : null,
      marker: kind === 'legacy-giant' ? null : VISIBLE_MARKER, host: hostname() }
  } catch (error) {
    await unlink(path)
    throw error
  } finally { await file.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    path: { type: 'string' }, bytes: { type: 'string' }, kind: { type: 'string' },
    provider: { type: 'string' }, 'expected-host': { type: 'string' },
  } })
  if (!values.path || !['sparse-io', 'valid-jsonl', 'legacy-giant'].includes(values.kind || '') || !['claude', 'codex'].includes(values.provider || '')) {
    throw new Error('Specify --path, --bytes, --kind, --provider and --expected-host')
  }
  process.env.GUGU_ACCEPTANCE_HOST = values['expected-host'] || ''
  await assertAcceptanceScope(process.env.GUGU_ACCEPTANCE_HOST)
  process.stdout.write(JSON.stringify(await createHistoryFixture(resolve(values.path), Number(values.bytes), values.kind as FixtureKind, values.provider as Provider)) + '\n')
}
