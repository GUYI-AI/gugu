import type { RuntimeManager } from '@main/core/runtime/types'

/** A workspace's files runtime and the Git runtime its Git opens from (whether it has Git is read later, from disk). */
export async function acquireWorkspaceRuntime(
  workspaceRuntime: { manager: Pick<RuntimeManager, 'acquire'> },
  workDir: string
) {
  const runtimeLease = await workspaceRuntime.manager.acquire()
  try {
    const files = runtimeLease.value.files
    const openedFileTree = await files.openTree(workDir)
    if (!openedFileTree.success) {
      throw new Error(`Failed to open file tree: ${JSON.stringify(openedFileTree.error)}`)
    }
    const fileTreeLease = openedFileTree.data

    let released = false
    return {
      git: runtimeLease.value.git,
      fileTree: fileTreeLease.value,
      filesRuntime: files,
      release: async () => {
        if (released) return
        released = true
        await fileTreeLease.release()
        await runtimeLease.release()
      }
    }
  } catch (error) {
    await runtimeLease.release()
    throw error
  }
}
