// 手机群里派「新任务」浮出来的文件夹卡列什么(OpenDCAI/gugu#446,spec mobile-session-view「新任务照电脑」):
// 群 = groupFoldersStore 里这个群;它在各台机器上的文件夹,哪台上的都列;离线的照列、标离线;没有文件夹 = 不浮卡。
import { describe, expect, it } from 'vitest'
import type { Device } from '../../../packages/core/src/shared/types/chat'
import type { GroupFolder, GroupWithFolders } from '../../../apps/desktop/src/session/renderer/features/folders/group-folders-store'
import { taskFoldersOfChat } from '../../../apps/desktop/src/mobile/chat/phoneTaskFolders'

const folder = (id: string, deviceId: string | null, path: string, over: Partial<GroupFolder> = {}): GroupFolder => ({
  id, path, chatId: 'g1', deviceId, sort: 1, gitless: null, branch: null, sessionIds: [], attachedAt: null, offline: false, ...over,
})
const device = (id: string, online: boolean, hostKind: 'desktop' | 'server' = 'desktop'): Device => ({
  device_id: id, label: id === 'mac' ? 'MacBook' : '', hostname: `${id}.local`, platform: 'darwin', status: 'active' as Device['status'],
  last_seen_at: '2026-10-26T00:00:00.000Z', is_online: online,
  capabilities: { host_kind: hostKind } as Device['capabilities'],
})
const g1 = (folders: GroupFolder[]): GroupWithFolders => ({ chatId: 'g1', name: '登录改版', activeAt: '2026-01-01T00:00:00.000Z', folders })
// The shared naming function (useMachineLabel).
const label = (row: Device) => `name:${row.device_id}`

describe('taskFoldersOfChat', () => {
  it('lists the group\'s folders on every machine, offline ones marked', () => {
    const got = taskFoldersOfChat(g1([
      folder('w1', 'mac', '/Users/a/login'),
      folder('w2', 'mac', '/Users/a/login-api', { sort: 2 }),
      folder('w3', 'box', '/srv/login', { offline: true }),
    ]), [device('mac', true), device('box', false, 'server'), device('other', true)], label)!
    expect(got.folders.map((one) => [one.id, one.deviceId, one.offline])).toEqual([
      ['w1', 'mac', false], ['w2', 'mac', false], ['w3', 'box', true],
    ])
    expect(got.name, 'named by the group').toBe('登录改版')
    expect(got.homeOf({ deviceId: 'mac', id: 'w1' })).toEqual({ deviceId: 'mac', folderId: 'w1', machine: { id: 'mac', label: 'name:mac', online: true, kind: 'computer' } })
    expect(got.homeOf({ deviceId: 'box', id: 'w3' })?.machine, 'named through the shared naming function').toEqual({ id: 'box', label: 'name:box', online: false, kind: 'server' })
  })

  it('leaves out folders on a machine this account does not list', () => {
    const got = taskFoldersOfChat(g1([folder('w1', 'mac', '/a'), folder('wx', 'gone', '/x')]), [device('mac', true)], label)!
    expect(got.folders.map((one) => one.id)).toEqual(['w1'])
    expect(got.homeOf({ deviceId: 'gone', id: 'wx' })).toBeUndefined()
  })

  it('a group with no folder on my machines floats no card', () => {
    expect(taskFoldersOfChat(undefined, [device('mac', true)], label)).toBeNull()
    expect(taskFoldersOfChat(g1([]), [device('mac', true)], label)).toBeNull()
    expect(taskFoldersOfChat(g1([folder('wx', 'gone', '/x')]), [device('mac', true)], label)).toBeNull()
  })
})
