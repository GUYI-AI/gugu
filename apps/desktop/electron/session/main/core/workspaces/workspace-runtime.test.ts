import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileSystem } from '@gugu/session-core/files'
import { ok } from '@gugu/session-shared'
import type { MachineRuntime } from '@main/core/runtime/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireWorkspaceRuntime } from './workspace-runtime'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('workspace runtime acquisition', () => {
  it('opens only the files side; Git is read later from disk', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-runtime-'))
    tempDirs.push(root)
    const releaseRuntime = vi.fn()
    const releaseTree = vi.fn()
    const fileSystem = new FileSystem()
    const openWorktree = vi.fn()
    const openTree = vi.fn(async () => ok({ value: { marker: 'files' }, release: releaseTree }))
    const runtime = {
      files: { path, fileSystem: () => ok(fileSystem), openTree },
      git: { openWorktree }
    } as unknown as MachineRuntime
    const manager = { acquire: vi.fn(async () => ({ value: runtime, release: releaseRuntime })) }

    const acquired = await acquireWorkspaceRuntime({ manager }, root)
    expect(openTree).toHaveBeenCalledWith(root)
    expect(openWorktree).not.toHaveBeenCalled()
    expect(acquired.git).toBe(runtime.git)
    const write = acquired.filesRuntime.fileSystem()
    if (!write.success) throw new Error(write.error.message)
    expect((await write.data.writeText(path.join(root, 'task-output.txt'), 'task still works')).success).toBe(true)
    await acquired.release()
    await acquired.release()
    expect(releaseTree).toHaveBeenCalledTimes(1)
    expect(releaseRuntime).toHaveBeenCalledTimes(1)
  })

  it('releases the runtime when the file tree cannot open', async () => {
    const releaseRuntime = vi.fn()
    const runtime = {
      files: { path, openTree: async () => ({ success: false, error: { type: 'denied' } }) },
      git: {}
    } as unknown as MachineRuntime
    const manager = { acquire: async () => ({ value: runtime, release: releaseRuntime }) }
    await expect(acquireWorkspaceRuntime({ manager }, '/remote/project')).rejects.toThrow('Failed to open file tree')
    expect(releaseRuntime).toHaveBeenCalledTimes(1)
  })
})
