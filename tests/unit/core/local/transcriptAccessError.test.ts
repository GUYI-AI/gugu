import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_ACCESS_CODES,
  TranscriptAccessError
} from '../../../../packages/core/src/local/agent/transcriptAccessError'
import { readLocalTranscript } from '../../../../packages/core/src/local/agent/transcriptInventory'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'transcript-access-'))
  dirs.push(root)
  await mkdir(join(root, 'projects'))
  return { root, options: { nativeHomes: { 'claude-code': [root], codex: [root] } } }
}

/** 失败时拿到的那个错；没失败就是测试失败。 */
async function failure(run: () => Promise<unknown>): Promise<TranscriptAccessError> {
  try { await run() } catch (error) { return error as TranscriptAccessError }
  throw new Error('expected the read to fail')
}

describe('TranscriptAccessError', () => {
  it('message is `<code>:<file name>`; the full path is data on filePath, never in the message', () => {
    const error = new TranscriptAccessError('transcript-unreadable', '/Users/someone/.claude/projects/-w/imp-8.jsonl')
    expect(error.message).toBe('transcript-unreadable:imp-8.jsonl')
    expect(error.message).not.toContain('/Users/someone')
    expect(error.code).toBe('transcript-unreadable')
    expect(error.filePath).toBe('/Users/someone/.claude/projects/-w/imp-8.jsonl')
    expect(error).toBeInstanceOf(Error)
  })

  it('a missing file fails with transcript-unreadable and names only the file', async () => {
    const { root, options } = await home()
    const path = join(root, 'projects', 'gone.jsonl')
    const error = await failure(() => readLocalTranscript(path, 'claude-code', options))
    expect(error).toBeInstanceOf(TranscriptAccessError)
    expect(error.code).toBe('transcript-unreadable')
    expect(error.message).toBe('transcript-unreadable:gone.jsonl')
    expect(error.message).not.toContain(root)
    expect(error.filePath).toBe(path)
  })

  it('a file outside the scan roots fails with transcript-outside-roots', async () => {
    const { root, options } = await home()
    const elsewhere = await mkdtemp(join(tmpdir(), 'transcript-elsewhere-'))
    dirs.push(elsewhere)
    const path = join(elsewhere, 'stray.jsonl')
    await writeFile(path, '{}\n')
    const error = await failure(() => readLocalTranscript(path, 'claude-code', options))
    expect(error.code).toBe('transcript-outside-roots')
    expect(error.message).toBe('transcript-outside-roots:stray.jsonl')
    expect(error.message).not.toContain(elsewhere)
    expect(root).not.toBe(elsewhere)
  })

  it('a transcript with no user or assistant turns fails with transcript-empty', async () => {
    const { root, options } = await home()
    const path = join(root, 'projects', 'blank.jsonl')
    await writeFile(path, '{"type":"summary"}\n')
    const error = await failure(() => readLocalTranscript(path, 'claude-code', options))
    expect(error.code).toBe('transcript-empty')
    expect(error.message).toBe('transcript-empty:blank.jsonl')
    expect(error.message).not.toContain(root)
  })

  it('exports the code list the desktop vocabulary must cover', () => {
    expect([...TRANSCRIPT_ACCESS_CODES]).toEqual([
      'transcript-unreadable',
      'transcript-outside-roots',
      'transcript-empty',
      'transcript-no-identity'
    ])
  })
})
