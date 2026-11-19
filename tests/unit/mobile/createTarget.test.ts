import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { GroupFolder, GroupWithFolders } from '@renderer/features/folders/group-folders-store'
import { accountProjects, createMachines, runCandidates } from '@/components/session-watch/create-target'
import { defaultRunMachine } from '@renderer/features/projects/components/main-panel/project-run-machine'

const folder = (id: string, deviceId: string, path = `/${id}`): GroupFolder => ({
  id, path, chatId: 'chat-work', deviceId, sort: 1, gitless: null, branch: null, sessionIds: [], attachedAt: null, offline: false,
})
const machine = (id: string, online: boolean, phone = false): Device => ({
  device_id: id, label: id, hostname: id, platform: phone ? 'android' : 'linux', status: online ? 'online' : 'offline',
  is_online: online, last_seen_at: '2026-11-09T00:00:00.000Z',
  capabilities: phone ? { terminals: [], runtimes: ['pi'], host_kind: 'phone', host_runtime_capability: 1 } : { terminals: [], runtimes: ['codex'] },
} as Device)
const defaultOf = (project: ReturnType<typeof accountProjects>[number] | null, machines: Device[], saved?: string) =>
  defaultRunMachine(runCandidates(createMachines(project, machines), project), saved)

describe('手机新建页的「项目 · 机器」(DESIGN 点击路径 4a)', () => {
  const gpu = machine('gpu', true)
  const juma = machine('juma', true)
  const wen = machine('wen', false)
  const mac = machine('mac', true)
  const phone = machine('phone', true, true)
  const machines = [mac, wen, juma, gpu, phone]
  // 群只来自 groupFoldersStore(桌面同一份);文件夹路径是各台机器上那个文件夹的。
  const store: GroupWithFolders[] = [
    { chatId: 'chat-work', name: 'work', activeAt: '2026-01-01T00:00:00.000Z', folders: [
      folder('gpu-work', 'gpu', '/root/work'), folder('juma-work', 'juma', '~/work'), folder('wen-work', 'wen', '~/work'),
    ] },
  ]
  const [work] = accountProjects(store, machines, () => false)

  it('#1629 个人助理宿主上的文件夹不列;文件夹全在那台上的群整个不列', () => {
    const host = machine('assistant-host', true)
    const onHost = (device: Device) => device.device_id === 'assistant-host'
    const groups: GroupWithFolders[] = [
      { ...store[0]!, folders: [...store[0]!.folders, folder('host-work', 'assistant-host')] },
      { chatId: 'chat-home', name: 'home', activeAt: null, folders: [folder('host-home', 'assistant-host')] },
      { chatId: 'chat-empty', name: 'empty', activeAt: null, folders: [] },
    ]
    const listed = accountProjects(groups, [...machines, host], onHost)
    expect(listed.map((one) => one.chatId)).toEqual(['chat-work', 'chat-empty'])
    expect(listed[0]!.homes.has('assistant-host')).toBe(false)
  })

  it('一个群在几台机器上有文件夹 = 一个群,带着各台上的文件夹', () => {
    expect(accountProjects(store, machines, () => false)).toHaveLength(1)
    expect(work).toMatchObject({ chatId: 'chat-work', name: 'work' })
    expect([...work!.homes]).toEqual(expect.arrayContaining([
      ['gpu', { folderId: 'gpu-work', path: '/root/work' }], ['juma', { folderId: 'juma-work', path: '~/work' }], ['wen', { folderId: 'wen-work', path: '~/work' }],
    ]))
  })

  // #2412 review ④: an offline machine is listed but not selectable, the same rule as the desktop picker (machineAcceptsWork).
  it('选了项目:有文件夹的在线机器在前、离线的在后(点不动),没有文件夹的电脑在下且点不动;手机不列', () => {
    const rows = createMachines(work!, machines)
    expect(rows.map((row) => [row.device.device_id, row.available, row.folderId, row.path])).toEqual([
      ['juma', true, 'juma-work', '~/work'],
      ['gpu', true, 'gpu-work', '/root/work'],
      ['wen', false, 'wen-work', '~/work'],
      ['mac', false, null, null],
    ])
  })

  it('默认机器:上次那台在线就用它 → 有文件夹的第一台在线的 → 都不在线才回上次那台;❌ 没有文件夹的那台', () => {
    expect(defaultOf(work!, machines, 'gpu')).toBe('gpu')
    expect(defaultOf(work!, machines, 'wen'), 'last used is offline').toBe('juma')
    expect(defaultOf(work!, machines, 'mac'), 'last used has no folder').toBe('juma')
    // Every folder machine is offline: the offline one stays chosen (send blocked, draft kept), never a machine without a folder.
    expect(defaultOf(work!, [mac, wen], 'wen')).toBe('wen')
    expect(defaultOf(work!, [mac, wen])).toBe('wen')
    expect(defaultOf(work!, [mac]), 'no machine has a folder').toBeNull()
  })

  it('不选项目:全部机器,电脑在前、手机任务宿主在最后;离线的点不动;默认 = 第一台能用的', () => {
    const rows = createMachines(null, [phone, ...machines.filter((one) => one !== phone)])
    expect(rows.map((row) => [row.device.device_id, row.available])).toEqual([['mac', true], ['wen', false], ['juma', true], ['gpu', true], ['phone', true]])
    expect(rows.every((row) => row.folderId === null)).toBe(true)
    expect(defaultOf(null, machines)).toBe('mac')
    expect(defaultOf(null, machines, 'wen'), 'offline is never the default').toBe('mac')
  })
})
