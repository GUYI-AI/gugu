import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalPath } from '@gugu/session-shared/canonical-path'
const state = vi.hoisted(() => ({
  rows: [] as { id: string; name: string; path: string; chatId: string }[],
  retained: null as null | { id: string; name: string; path: string; chatId: string },
  status: 'archived', restore: vi.fn(), archive: vi.fn(), changed: vi.fn(), save: vi.fn(), inspect: vi.fn(), invalidate: vi.fn(),
}))
vi.mock('@/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ folders: {
  listUnavailableFolders: async () => state.rows,
  findRetainedFolderAtPath: async () => state.retained,
  inspectFolderRecovery: state.inspect,
  restoreFolder: state.save,
} }) }))
vi.mock('@/store/devicesCache', () => ({ cachedDevicesAccount: () => 'owner', subscribeCachedDevices: () => () => {} }))
vi.mock('@/lib/replica', () => ({ queryClient: { invalidateQueries: state.invalidate } }))
vi.mock('@/lib/archivedGroupsRead', () => ({ noteGroupArchived: state.changed, readArchivedGroups: () => new Set(), subscribeArchivedGroups: () => () => {} }))
vi.mock('@/lib/groupAdmin', () => ({ currentGroupAdmin: async () => ({ restore: state.restore, archive: state.archive }) }))
vi.mock('@/lib/supabase', () => ({ chatDb: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: state.status }, error: null }) }) }) }) } }))
import { archiveUnavailableProjects, projectRecoveryMessage, recoverRetainedFolderAtPath, recoverUnavailableProject } from '../../../../apps/desktop/src/lib/projectRecovery'

const original = { id: 'original', name: '论文伴读', path: '/old' as CanonicalPath, chatId: 'original-group' }
beforeEach(() => {
  vi.clearAllMocks(); state.rows = [original]; state.retained = original; state.status = 'archived'
  state.restore.mockResolvedValue({ chat_id: original.chatId, status: 'active' })
  state.inspect.mockResolvedValue({ success: true, data: { path: '/selected', isGitRepo: false } })
  state.save.mockResolvedValue({ success: true, data: { id: original.id } })
})
describe('folder recovery actions', () => {
  it('after cleanup, making a group with the original folder restores its existing group and folder ID', async () => {
    expect(await recoverRetainedFolderAtPath('/old')).toBe('original-group')
    expect(state.restore).toHaveBeenCalledWith('original-group')
    expect(state.save).toHaveBeenCalledWith('original', '/old')
    expect(state.restore.mock.invocationCallOrder[0]).toBeLessThan(state.save.mock.invocationCallOrder[0])
  })
  it.each(['/renamed', '/other'])('leaves unmatched folder %s to the ordinary new-group path', async path => {
    state.retained = null
    expect(await recoverRetainedFolderAtPath(path)).toBeNull()
    expect(state.restore).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled()
  })
  it('leaves a folder whose group is still active to the ordinary new-group path', async () => {
    state.status = 'active'
    expect(await recoverRetainedFolderAtPath('/old')).toBeNull()
    expect(state.restore).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled()
  })
  it('does not change the local path or success state if archived topic recovery is refused', async () => {
    state.restore.mockRejectedValue(new Error('group_recovery_requires_topic_evidence'))
    await expect(recoverUnavailableProject(original, '/selected')).rejects.toThrow('group_recovery_requires_topic_evidence')
    expect(state.save).not.toHaveBeenCalled(); expect(state.changed).not.toHaveBeenCalled()
    expect(projectRecoveryMessage(new Error('group_recovery_requires_topic_evidence'))).toBe('恢复记录不完整，请联系维护者核对。')
  })
  it('validates a selected folder before restoring its group', async () => {
    state.inspect.mockResolvedValue({ success: false, error: { type: 'path-conflict', message: '文件夹已属于其他项目' } })
    await expect(recoverUnavailableProject(original, '/selected')).rejects.toMatchObject({ type: 'path-conflict' })
    expect(state.restore).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled()
  })
  it('archives only after an explicit call and preserves the retained folders for restoration', async () => {
    expect(state.archive).not.toHaveBeenCalled()
    await archiveUnavailableProjects([original])
    expect(state.archive).toHaveBeenCalledWith('original-group')
    expect(state.rows).toEqual([original]); expect(state.changed).toHaveBeenCalledWith('original-group', true)
  })
  it('does not clean a folder restored after the confirmation was opened', async () => {
    state.rows = []
    await expect(archiveUnavailableProjects([original])).rejects.toMatchObject({ type: 'state-changed' })
    expect(state.archive).not.toHaveBeenCalled()
  })
})
