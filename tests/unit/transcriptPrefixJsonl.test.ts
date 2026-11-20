import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readFirstLines } from '../../packages/core/src/local/agent/transcriptInventory'

it('uses LF and preserves UTF-8 across the bounded positional inventory blocks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-jsonl-prefix-'))
  try {
    const file = join(dir, 'record.jsonl')
    const first = JSON.stringify({ uuid: 'first', text: 'a'.repeat(65_520) + '中🙂\u2028\u2029' })
    await writeFile(file, first + '\r\n' + JSON.stringify({ uuid: 'second' }) + '\n')
    expect(await readFirstLines(file, 1)).toEqual([first])
    expect((await readFirstLines(file, 2)).map(line => JSON.parse(line).uuid)).toEqual(['first', 'second'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it('retains the existing one-MiB positional prefix ceiling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-jsonl-prefix-budget-'))
  try {
    const file = join(dir, 'record.jsonl')
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024) + '\n' + '{"uuid":"beyond-ceiling"}\n')
    const lines = await readFirstLines(file, 50)
    expect(lines).toHaveLength(1)
    expect(Buffer.byteLength(lines[0])).toBe(1024 * 1024)
    expect(lines[0]).not.toContain('beyond-ceiling')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
