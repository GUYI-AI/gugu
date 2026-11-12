import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ChatTaskFolders } from '../../../apps/desktop/src/mobile/chat/phoneTaskFolders'

const rpc = vi.hoisted(() => ({ projects: {
  attachProjectFolder: vi.fn(), detachProjectFolder: vi.fn(), inspectProjectPath: vi.fn(),
  createProject: vi.fn(), ensureProjectGroup: vi.fn(), bindProjectToGroup: vi.fn(),
  unbindProjectGroup: vi.fn(), deleteProject: vi.fn(), listProjectFolders: vi.fn(),
}, sessions: { getSessionsForProject: vi.fn() } }))
vi.mock('../../../apps/desktop/src/mobile/partners/projectRpc', () => ({ projectRpcOn: () => rpc }))
const { attachPhoneProjectFolder } = await import('../../../apps/desktop/src/mobile/chat/attachPhoneProjectFolder')
const device = { device_id: 'mac' } as Device
const folder = { workspaceId: 'folder', projectId: 'local', kind: 'attached', path: '/work/extra', branch: null, sessionIds: [], attachedAt: null }
const project = (onMachine = 'mac'): ChatTaskFolders => ({
  rowId: 'local', name: 'Work', memberIds: ['local'], folders: [],
  homeOf: () => ({ deviceId: onMachine, localProjectId: 'local', machine: { label: onMachine, online: true, kind: 'computer' } }),
})
beforeEach(() => {
  vi.resetAllMocks()
  rpc.projects.attachProjectFolder.mockResolvedValue({ success: true, data: folder })
  rpc.projects.detachProjectFolder.mockResolvedValue({ success: true })
  rpc.projects.inspectProjectPath.mockResolvedValue({})
  rpc.projects.ensureProjectGroup.mockResolvedValue({ success: true, data: { chatId: 'group' } })
  rpc.projects.createProject.mockResolvedValue({ success: true, data: { id: 'new-local' } })
  rpc.projects.bindProjectToGroup.mockResolvedValue({ success: true })
  rpc.projects.unbindProjectGroup.mockResolvedValue({ success: true })
  rpc.projects.listProjectFolders.mockResolvedValue({ success: true, data: [{ ...folder, projectId: 'new-local' }] })
  rpc.sessions.getSessionsForProject.mockResolvedValue([])
})
describe('phone folder attachment uses the shared project rules', () => {
  it('attaches on an existing project machine and undo detaches that exact workspace', async () => {
    const result = await attachPhoneProjectFolder({ project: project(), device, devices: [device], path: folder.path, confirmMerge: vi.fn() })
    expect(rpc.projects.attachProjectFolder).toHaveBeenCalledWith('local', folder.path)
    expect(result?.folder).toEqual(folder)
    await result?.undo()
    expect(rpc.projects.detachProjectFolder).toHaveBeenCalledWith('local', 'folder')
    expect(rpc.projects.createProject).not.toHaveBeenCalled()
  })
  it('links a new machine to the same group, and undo preserves any sessions created since attaching', async () => {
    const result = await attachPhoneProjectFolder({ project: project('other'), device, devices: [device, { device_id: 'other' } as Device], path: folder.path, confirmMerge: vi.fn() })
    expect(rpc.projects.bindProjectToGroup).toHaveBeenCalledWith('new-local', 'group')
    rpc.sessions.getSessionsForProject.mockResolvedValue([{ id: 'session-created-later' }])
    await result?.undo()
    expect(rpc.projects.unbindProjectGroup).toHaveBeenCalledWith('new-local')
    expect(rpc.projects.deleteProject).not.toHaveBeenCalled()
  })
  it('does not merge an occupied project until its session count has been confirmed', async () => {
    rpc.projects.attachProjectFolder.mockResolvedValue({ success: false, error: { type: 'is-project-root', projectId: 'existing', projectName: 'Existing' } })
    rpc.sessions.getSessionsForProject.mockResolvedValue([{ id: 's1' }])
    const confirmMerge = vi.fn().mockResolvedValue(false)
    expect(await attachPhoneProjectFolder({ project: project(), device, devices: [device], path: folder.path, confirmMerge })).toBeNull()
    expect(confirmMerge).toHaveBeenCalledWith('Existing', 1)
    expect(rpc.projects.bindProjectToGroup).not.toHaveBeenCalled()
  })
  it('cleans only the newly created project record if group binding fails', async () => {
    // The host keeps the id it was asked for when it creates the project (an existing one answers its own id).
    rpc.projects.createProject.mockImplementation(async (params: { id: string }) => ({ success: true, data: { id: params.id } }))
    rpc.projects.bindProjectToGroup.mockResolvedValue({ success: false, error: new Error('group unavailable') })
    await expect(attachPhoneProjectFolder({ project: project('other'), device, devices: [device, { device_id: 'other' } as Device], path: folder.path, confirmMerge: vi.fn() })).rejects.toThrow('group unavailable')
    const created = (rpc.projects.createProject.mock.calls[0]?.[0] as { id: string }).id
    expect(rpc.projects.deleteProject).toHaveBeenCalledWith(created)
  })
  // A folder unbound from this project earlier is still a (detached) project there: binding it again goes through the
  // host's create, which answers that project and re-attaches its root; it is not new, so undo and failures keep it.
  it('re-binding a folder detached earlier re-attaches that project and never deletes it', async () => {
    rpc.projects.inspectProjectPath.mockResolvedValue({ existingProject: { id: 'detached', name: 'site', path: folder.path } })
    rpc.projects.createProject.mockResolvedValue({ success: true, data: { id: 'detached' } })
    rpc.projects.listProjectFolders.mockResolvedValue({ success: true, data: [{ ...folder, projectId: 'detached' }] })
    rpc.projects.bindProjectToGroup.mockResolvedValue({ success: false, error: new Error('group unavailable') })
    await expect(attachPhoneProjectFolder({ project: project('other'), device, devices: [device, { device_id: 'other' } as Device], path: folder.path, confirmMerge: vi.fn() })).rejects.toThrow('group unavailable')
    expect(rpc.projects.createProject).toHaveBeenCalledWith(expect.objectContaining({ path: folder.path }))
    expect(rpc.projects.deleteProject).not.toHaveBeenCalled()
  })
})
