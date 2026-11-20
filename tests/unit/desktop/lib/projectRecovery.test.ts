import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalPath } from '@gugu/session-shared/canonical-path'
const state = vi.hoisted(() => ({
  rows: [] as { id: string; name: string; path: string; chatId: string }[],
  retained: null as null | { id: string; name: string; path: string; chatId: string },
  status: 'archived', restore: vi.fn(), archive: vi.fn(), changed: vi.fn(), save: vi.fn(), inspect: vi.fn(), invalidate: vi.fn(), create: vi.fn(), notify: vi.fn(), logError: vi.fn(),
}))
vi.mock('@/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ projects: {
  listUnavailableProjects: async () => state.rows,
  findRetainedProjectAtPath: async () => state.retained,
  inspectProjectRecovery: state.inspect,
  restoreProjectFolder: state.save,
} }) }))
vi.mock('@/lib/replica', () => ({ replica: () => ({ refresh: state.invalidate }), useReplica: () => ({ state: 'unknown' }) }))
vi.mock('@/lib/archivedGroupsRead', () => ({ noteGroupArchived: state.changed, readArchivedGroups: () => new Set(), subscribeArchivedGroups: () => () => {} }))
vi.mock('@/lib/groupAdmin', () => ({ currentGroupAdmin: async () => ({ restore: state.restore, archive: state.archive }) }))
vi.mock('@/lib/supabase', () => ({ chatDb: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { status: state.status }, error: null }) }) }) }) } }))
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ createProject: state.create, projects: new Map(), removeUnregisteredProject: vi.fn() }) }))
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: state.notify }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: state.logError }) }))
import { archiveUnavailableProjects, projectRecoveryMessage, recoverUnavailableProject } from '../../../../apps/desktop/src/lib/projectRecovery'
import { createProjectFromLocalFolder } from '../../../../apps/desktop/src/session/renderer/features/projects/components/create-project-from-local-folder'

const original = { id: 'original', name: '论文伴读', path: '/old' as CanonicalPath, chatId: 'original-group' }
beforeEach(() => {
  vi.clearAllMocks(); state.rows = [original]; state.retained = original; state.status = 'archived'
  state.restore.mockResolvedValue({ chat_id: original.chatId, status: 'active' })
  state.inspect.mockResolvedValue({ success: true, data: { path: '/selected', isGitRepo: false } })
  state.save.mockResolvedValue({ success: true, data: { id: original.id } })
  state.create.mockResolvedValue('new-project')
})
describe('project recovery actions', () => {
  it('after cleanup, selecting the original folder restores its existing group and project ID', async () => {
    expect(await createProjectFromLocalFolder('/old', key => key)).toBe('original')
    expect(state.restore).toHaveBeenCalledWith('original-group')
    expect(state.save).toHaveBeenCalledWith('original', '/old')
    expect(state.restore.mock.invocationCallOrder[0]).toBeLessThan(state.save.mock.invocationCallOrder[0])
    expect(state.create).not.toHaveBeenCalled()
  })
  it.each(['/renamed', '/other'])('leaves unmatched folder %s to the ordinary new-project path', async path => {
    state.retained = null
    expect(await createProjectFromLocalFolder(path, key => key)).toBe('new-project')
    expect(state.restore).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled()
    expect(state.create).toHaveBeenCalledWith({ type: 'local' }, expect.objectContaining({ mode: 'pick', path }), expect.any(String))
  })
  it('does not change the local path or success state if archived topic recovery is refused', async () => {
    state.restore.mockRejectedValue(new Error('group_recovery_requires_topic_evidence'))
    await expect(recoverUnavailableProject(original, '/selected')).rejects.toThrow('group_recovery_requires_topic_evidence')
    expect(state.save).not.toHaveBeenCalled(); expect(state.changed).not.toHaveBeenCalled()
    expect(projectRecoveryMessage(new Error('group_recovery_requires_topic_evidence'))).toBe('恢复记录不完整，请联系维护者核对')
  })
  it.each([
    ['group_recovery_requires_topic_evidence', '恢复记录不完整，请联系维护者核对'],
    ['SQLITE_BUSY internal diagnostic detail', '请检查文件夹访问权限和项目群权限后再试。'],
  ])('keeps diagnostic %s in the logger and shows only approved next-step copy', async (diagnostic, description) => {
    state.restore.mockRejectedValue(new Error(diagnostic))
    expect(await createProjectFromLocalFolder('/old', key => key)).toBeNull()
    expect(state.notify).toHaveBeenCalledWith({ title: '恢复项目未完成', description, variant: 'destructive' })
    expect(state.logError).toHaveBeenCalledWith({ path: '/old', error: diagnostic }, '恢复原项目失败')
    expect(state.save).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled()
  })
  it('validates a selected folder before restoring its group', async () => {
    state.inspect.mockResolvedValue({ success: false, error: { message: '文件夹已属于其他项目' } })
    await expect(recoverUnavailableProject(original, '/selected')).rejects.toThrow()
    expect(state.restore).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled()
  })
  it('archives only after an explicit call and preserves the retained projects for restoration', async () => {
    expect(state.archive).not.toHaveBeenCalled()
    await archiveUnavailableProjects([original])
    expect(state.archive).toHaveBeenCalledWith('original-group')
    expect(state.rows).toEqual([original]); expect(state.changed).toHaveBeenCalledWith('original-group', true)
  })
  it('does not clean a folder restored after the confirmation was opened', async () => {
    state.rows = []
    await expect(archiveUnavailableProjects([original])).rejects.toThrow('项目状态已变化')
    expect(state.archive).not.toHaveBeenCalled()
  })
})
