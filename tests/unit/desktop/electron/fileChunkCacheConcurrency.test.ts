import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Gate = { entered(): void; resume: Promise<void> }
const hooks = vi.hoisted(() => ({
  directory: '', events: [] as string[],
  remove: null as Gate | null, read: null as Gate | null, write: null as Gate | null,
  refusal: null as Error | null,
}))

// Pause real filesystem operations, without replacing the path-boundary decisions.
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const { join, resolve, sep } = await import('node:path')
  return { ...fs,
    async rm(...args: Parameters<typeof fs.rm>) {
      const tracked = resolve(String(args[0])) === hooks.directory
      if (tracked) {
        hooks.events.push('remove-start')
        const gate = hooks.remove; hooks.remove = null
        if (gate) { gate.entered(); await gate.resume }
      }
      try { return await fs.rm(...args) }
      finally { if (tracked) hooks.events.push('remove-end') }
    },
    async readFile(...args: Parameters<typeof fs.readFile>) {
      const tracked = resolve(String(args[0])) === join(hooks.directory, '0')
      if (tracked) {
        hooks.events.push('read-start')
        const gate = hooks.read; hooks.read = null
        if (gate) { gate.entered(); await gate.resume }
      }
      try { return await fs.readFile(...args) }
      finally { if (tracked) hooks.events.push('read-end') }
    },
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      const file = resolve(String(args[0]))
      const tracked = file.startsWith(`${hooks.directory}${sep}`) && file.endsWith('.part')
      if (tracked) {
        hooks.events.push('write-start')
        const gate = hooks.write; hooks.write = null
        if (gate) { gate.entered(); await gate.resume }
      }
      try { return await fs.writeFile(...args) }
      finally { if (tracked) hooks.events.push('write-end') }
    },
  }
})
vi.mock('../../../../packages/core/src/local/state/agentFileBoundary', async importOriginal => {
  const boundary = await importOriginal<typeof import('../../../../packages/core/src/local/state/agentFileBoundary')>()
  const { resolve } = await import('node:path')
  return { ...boundary, async requireAgentFileTreeAccess(...args: Parameters<typeof boundary.requireAgentFileTreeAccess>) {
    if (resolve(args[0]) === hooks.directory) {
      hooks.events.push('tree-check')
      if (hooks.refusal) { const error = hooks.refusal; hooks.refusal = null; throw error }
    }
    return boundary.requireAgentFileTreeAccess(...args)
  } }
})

import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createFileChunkCache } from '../../../../packages/core/src/local/files/fileSnapshots'

const key = 'a'.repeat(64)
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let root: string
let releases: (() => void)[]
const pause = (kind: 'remove' | 'read' | 'write') => {
  const entered = deferred(), resume = deferred()
  hooks[kind] = { entered: entered.resolve, resume: resume.promise }
  releases.push(resume.resolve)
  return { entered: entered.promise, release: resume.resolve }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gugu-file-chunk-cache-race-')))
  hooks.directory = join(root, `open-${key}`)
  hooks.refusal = null; hooks.remove = null; hooks.read = null; hooks.write = null
  releases = []
  await createFileChunkCache(root).put(key, 0, new Uint8Array([1, 2, 3]))
  hooks.events = []
})
afterEach(async () => {
  releases.forEach(release => release())
  hooks.directory = ''; hooks.refusal = null
  await rm(root, { recursive: true, force: true })
})

describe('shared file chunk cache operation ownership', () => {
  it('finishes one cleanup before another instance checks the same normalized directory', async () => {
    const gate = pause('remove')
    const first = createFileChunkCache(root).clear(key)
    await gate.entered
    const second = createFileChunkCache(relative(process.cwd(), root)).clear(key)
    const finished = Promise.allSettled([first, second])
    gate.release()
    expect((await finished).map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(hooks.events).toEqual(['tree-check', 'remove-start', 'remove-end', 'tree-check', 'remove-start', 'remove-end'])
    expect(await readdir(root)).toEqual([])
  })

  it('does not clear a chunk between its checked read and readFile', async () => {
    const gate = pause('read')
    const reading = createFileChunkCache(root).get(key, 0)
    await gate.entered
    const clearing = createFileChunkCache(root).clear(key)
    const finished = Promise.allSettled([reading, clearing])
    gate.release()
    const results = await finished
    expect(results[0]).toEqual({ status: 'fulfilled', value: new Uint8Array([1, 2, 3]) })
    expect(results[1]?.status).toBe('fulfilled')
    expect(hooks.events.indexOf('tree-check')).toBeGreaterThan(hooks.events.indexOf('read-end'))
    expect(await readdir(root)).toEqual([])
  })

  it('does not clear a writer’s directory before its private part is published', async () => {
    const gate = pause('write')
    const writing = createFileChunkCache(root).put(key, 1, new Uint8Array([4, 5, 6]))
    await gate.entered
    const clearing = createFileChunkCache(root).clear(key)
    const finished = Promise.allSettled([writing, clearing])
    gate.release()
    expect((await finished).map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(hooks.events.indexOf('tree-check')).toBeGreaterThan(hooks.events.indexOf('write-end'))
    expect(await readdir(root)).toEqual([])
  })

  it('keeps other cache keys and roots independent of a blocked cleanup', async () => {
    const cache = createFileChunkCache(root), otherKey = 'b'.repeat(64), otherRoot = join(root, 'other')
    await cache.put(otherKey, 0, new Uint8Array([7]))
    await createFileChunkCache(otherRoot).put(key, 0, new Uint8Array([8]))
    const gate = pause('remove'), clearing = cache.clear(key)
    await gate.entered
    try {
      await Promise.all([cache.clear(otherKey), createFileChunkCache(otherRoot).clear(key)])
      expect(await stat(hooks.directory)).toBeDefined()
      expect(await readdir(otherRoot)).toEqual([])
    } finally { gate.release(); await clearing }
  })

  it('propagates a boundary refusal without deleting bytes or poisoning later operations', async () => {
    const denied = new Error('Controlled boundary refusal')
    hooks.refusal = denied
    await expect(createFileChunkCache(root).clear(key)).rejects.toBe(denied)
    expect(await readFile(join(hooks.directory, '0'))).toEqual(Buffer.from([1, 2, 3]))
    expect(hooks.events).not.toContain('remove-start')
    await createFileChunkCache(root).clear(key)
    expect(await readdir(root)).toEqual([])
  })
})
