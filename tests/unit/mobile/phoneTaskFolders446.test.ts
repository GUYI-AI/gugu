// 手机项目群派「新任务」浮出来的文件夹卡列什么(OpenDCAI/gugu#446,spec mobile-session-view「新任务照电脑」):
// 项目 = accountProjectsStore 里这个群;它在各台机器上的本地项目,哪台上的都列;离线的照列、标离线;读不到的标「上次的」;
// 个人助理宿主不列(R15);不是账号上的项目 = 不是项目群。
import { describe, expect, it } from 'vitest'
import type { Device } from '../../../packages/core/src/shared/types/chat'
import type { AccountProject } from '../../../packages/core/src/cloud/deviceProjects'
import type { DeviceProject } from '../../../packages/core/src/shared/types/deviceProject'
import { taskFoldersOfChat } from '../../../apps/desktop/src/mobile/chat/phoneTaskFolders'

const project = (over: Partial<DeviceProject>): DeviceProject => ({
  localProjectId: 'p', name: '本地名', rootPath: '/r', createdAt: '2026-10-26T00:00:00.000Z', chatId: 'g1',
  folders: [], ...over,
})
const device = (id: string, online: boolean, projects: DeviceProject[], hostKind: 'desktop' | 'server' = 'desktop', extra: Partial<Device> = {}): Device => ({
  device_id: id, label: id === 'mac' ? 'MacBook' : '', hostname: `${id}.local`, platform: 'darwin', status: 'active' as Device['status'],
  last_seen_at: '2026-10-26T00:00:00.000Z', is_online: online,
  capabilities: { host_kind: hostKind } as Device['capabilities'], projects, ...extra,
})
const g1 = (bindings: Array<[string, string]>): AccountProject => ({
  chatId: 'g1', name: '登录改版', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: bindings.map(([deviceId, localProjectId]) => ({ deviceId, localProjectId })),
})
// The shared naming function (useMachineLabel): the assistant host says the assistant's name, others their label.
const machines = (homeId: string | null = null) => ({
  label: (row: Device) => (row.device_id === homeId ? '小咕' : `name:${row.device_id}`),
  isHome: (row: { device_id: string }) => row.device_id === homeId,
})

describe('taskFoldersOfChat', () => {
  it('lists the folders of every local project of the account project, on every machine, offline ones marked', () => {
    const got = taskFoldersOfChat(g1([['mac', 'p-mac'], ['box', 'p-box']]), [
      device('mac', true, [project({ localProjectId: 'p-mac', folders: [
        { workspaceId: 'w1', kind: 'root', path: '/Users/a/login', attachedAt: null },
        { workspaceId: 'w2', kind: 'attached', path: '/Users/a/login-api', attachedAt: '2026-10-25T00:00:00.000Z' },
      ] })]),
      device('box', false, [project({ localProjectId: 'p-box', folders: [
        { workspaceId: 'w3', kind: 'root', path: '/srv/login', attachedAt: null },
      ] })], 'server'),
      device('other', true, [project({ localProjectId: 'p-x', chatId: 'g2', folders: [{ workspaceId: 'w9', kind: 'root', path: '/x', attachedAt: null }] })]),
    ], machines())!
    expect(got.folders.map((folder) => [folder.workspaceId, folder.projectId, folder.offline, folder.stale ?? false])).toEqual([
      ['w1', 'p-mac', false, false], ['w2', 'p-mac', false, false], ['w3', 'p-box', true, false],
    ])
    expect(got.name, 'named by the account project').toBe('登录改版')
    expect(got.memberIds).toEqual(['p-mac', 'p-box'])
    expect(got.rowId, 'the card is named after the copy on a connected machine, not the offline one (groupRowOrder)').toBe('p-mac')
    expect(got.homeOf('p-mac')).toEqual({ deviceId: 'mac', localProjectId: 'p-mac', machine: { id: 'mac', label: 'name:mac', online: true, kind: 'computer' } })
    expect(got.homeOf('p-box')?.machine, 'named through the shared naming function').toEqual({ id: 'box', label: 'name:box', online: false, kind: 'server' })
  })

  it('leaves out the personal assistant\'s host, even when its copy is bound to the user\'s project group (R15)', () => {
    const got = taskFoldersOfChat(g1([['mac', 'p-mac'], ['cloud', 'p-cloud']]), [
      device('mac', true, [project({ localProjectId: 'p-mac', folders: [{ workspaceId: 'w1', kind: 'root', path: '/a', attachedAt: null }] })]),
      device('cloud', true, [project({ localProjectId: 'p-cloud', createdAt: '2020-01-01T00:00:00.000Z', folders: [{ workspaceId: 'wc', kind: 'root', path: '/home/assistant', attachedAt: null }] })], 'server'),
    ], machines('cloud'))!
    expect(got.memberIds).toEqual(['p-mac'])
    expect(got.folders.map((folder) => folder.workspaceId)).toEqual(['w1'])
    expect(got.homeOf('p-cloud')).toBeUndefined()
    expect(taskFoldersOfChat(g1([['cloud', 'p-cloud']]), [device('cloud', true, [project({ localProjectId: 'p-cloud' })])], machines('cloud')), 'bound only on the host').toBeNull()
  })

  it('marks the folders of a machine whose projects this end could not read as stale', () => {
    const got = taskFoldersOfChat(g1([['mac', 'p-mac']]), [
      device('mac', true, [project({ localProjectId: 'p-mac', folders: [{ workspaceId: 'w1', kind: 'root', path: '/a', attachedAt: null }] })], 'desktop', { projects_error: 'permission denied' }),
    ], machines())!
    expect(got.folders.map((folder) => folder.stale)).toEqual([true])
  })

  it('a group that is not an account project, or has no machine, is not a project group', () => {
    expect(taskFoldersOfChat(undefined, [device('mac', true, [project({ chatId: 'g1' })])], machines())).toBeNull()
    expect(taskFoldersOfChat(g1([]), [device('new', true, [])], machines())).toBeNull()
  })
})
