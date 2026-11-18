import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import { createBoundExec } from '@gugu/session-core/exec'
import { readGitStatus } from '@gugu/session-core/git/status-reader'
import { createGitStatusClient } from '@gugu/session-core/git/status-worker'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
let root: string
let bundle: string
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-status-worker-'))
  bundle = path.join(root, 'worker.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
    logLevel: 'silent'
  })
})
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
const client = () => createGitStatusClient(() => new Worker(bundle, { execArgv: [] }))

describe('bundled Git status worker', () => {
  it('preserves the complete model, filenames and counts from the core reader', async () => {
    const repo = path.join(root, 'repo')
    await fs.mkdir(repo)
    const git = (args: string[]) => exec('git', args, { cwd: repo })
    await git(['init', '-q'])
    await git(['config', 'user.name', 'Test'])
    await git(['config', 'user.email', 'test@example.invalid'])
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'before\n')
    await git(['add', '.'])
    await git(['commit', '-qm', 'fixture'])
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'after\n')
    await fs.mkdir(path.join(repo, 'new directory'))
    await fs.writeFile(path.join(repo, 'new directory', '资料.txt'), 'one\ntwo\n')
    const reader = client()
    try {
      const result = await reader.read({ worktree: repo, file: 'git' })
      expect(result).toEqual(await readGitStatus(repo, createBoundExec({ file: 'git', cwd: repo })))
      expect(result).toMatchObject({
        kind: 'ok',
        unstaged: expect.arrayContaining([
          expect.objectContaining({
            path: path.join(repo, 'new directory', '资料.txt'),
            additions: 2
          })
        ])
      })
      await expect(
        reader.read({ worktree: repo, file: path.join(root, 'missing-git') })
      ).resolves.toMatchObject({ kind: 'error' })
    } finally {
      await reader.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'aborts owned git children before the worker exits',
    async () => {
      const executable = path.join(root, 'blocking-git')
      const pidsFile = path.join(root, 'owned-pids')
      await fs.writeFile(executable, `#!/bin/sh\necho $$ >> '${pidsFile}'\nexec sleep 60\n`, {
        mode: 0o755
      })
      const reader = client()
      const reading = reader.read({ worktree: root, file: executable })
      const rejected = expect(reading).rejects.toThrow('disposed')
      let pids: number[] = []
      try {
        await expect
          .poll(async () => {
            pids = (await fs.readFile(pidsFile, 'utf8').catch(() => ''))
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .map(Number)
            return pids.length
          })
          .toBe(3)
        await reader.dispose()
        await rejected
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        await reader.dispose()
      }
    }
  )
})
