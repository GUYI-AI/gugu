import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { countFileLines } from './file-line-count'

afterEach(() => vi.restoreAllMocks())

async function fixture(content: string, test: (file: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-line-count-'))
  const file = path.join(root, 'file.txt')
  try {
    await fs.writeFile(file, content)
    await test(file)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe('untracked file line counts', () => {
  it.each([
    ['', 16, 0, false],
    ['one', 16, 1, false],
    ['one\ntwo\n', 16, 2, false],
    ['资料\n第二行', 32, 2, false],
    ['one\ntwo\n', 8, 2, false],
    ['one\ntwo\n', 5, 2, true],
    ['one\n', 0, 0, true]
  ] as const)('counts %j with a %i-byte bound', async (content, maxBytes, lines, truncated) => {
    await fixture(content, async (file) => {
      await expect(countFileLines(file, { maxBytes })).resolves.toEqual({
        lines,
        truncated,
        totalSize: Buffer.byteLength(content)
      })
    })
  })

  it.each([16, 5])(
    'detects growth after stat without losing the %i-byte boundary',
    async (maxBytes) => {
      await fixture('one\ntwo\n', async (file) => {
        const stale = await fs.stat(file)
        stale.size = 1
        vi.spyOn(fs, 'stat').mockResolvedValueOnce(stale)
        await expect(countFileLines(file, { maxBytes })).resolves.toEqual({
          lines: 2,
          truncated: maxBytes === 5,
          totalSize: 1
        })
      })
    }
  )

  it('reads only initialized bytes if the file shrinks after stat', async () => {
    await fixture('one\n', async (file) => {
      const stale = await fs.stat(file)
      stale.size = 100
      vi.spyOn(fs, 'stat').mockResolvedValueOnce(stale)
      await expect(countFileLines(file, { maxBytes: 128 })).resolves.toEqual({
        lines: 1,
        truncated: false,
        totalSize: 100
      })
    })
  })
})
