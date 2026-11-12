import { describe, expect, it } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import { phoneProjectRows } from '../../../../apps/desktop/src/mobile/assistant/phoneProjectRows'
import { isAssistantHome } from '../../../../apps/desktop/src/lib/assistantHome'

const homeOf = (cloudDeviceId: string | null) => (row: Parameters<typeof isAssistantHome>[0]) => isAssistantHome(row, cloudDeviceId)

// The phone project list is the account project list (accountProjectsStore); folder paths come from the devices
// store's device_projects (no read of its own).
// #1629 parity: a project bound only on the personal assistant's host is not one of the person's projects.

const device = (id: string, extra: Partial<Device> = {}): Device => ({
  device_id: id,
  label: id,
  is_online: true,
  is_current_device: false,
  cloud_computer: null,
  capabilities: {},
  ...extra,
} as unknown as Device)

const record = (localProjectId: string): DeviceProject => ({
  localProjectId,
  name: localProjectId,
  rootPath: `/home/${localProjectId}`,
  createdAt: '2026-11-01T00:00:00.000Z',
  chatId: null,
  folders: [{ workspaceId: `${localProjectId}-root`, kind: 'root', path: `/home/${localProjectId}`, attachedAt: null }],
})

const project = (chatId: string, name: string, bindings: Array<[string, string]>, archived = false): AccountProject => ({
  chatId, name, archived, activeAt: '2026-01-01T00:00:00.000Z', bindings: bindings.map(([deviceId, localProjectId]) => ({ deviceId, localProjectId })),
})

describe('phone projects list = account projects', () => {
  it('one entry per account project, folders of every machine it is bound on (connected machine first), named by the project', () => {
    const rows = phoneProjectRows([
      project('chat-paper', 'Paper', [['laptop', 'l-paper'], ['desk', 'd-paper']]),
      project('chat-empty', 'Empty', []),
      project('chat-old', 'Old', [], true),
    ], [device('laptop', { projects: [record('l-paper')] }), device('desk', { projects: [record('d-paper')], is_online: false })], homeOf(null))
    expect(rows.map(row => [row.id, row.label, row.folders.map(folder => folder.path)])).toEqual([
      ['chat-paper', 'Paper', ['/home/l-paper', '/home/d-paper']],
      ['chat-empty', 'Empty', []],
    ])
    expect(rows[0]!.rootPath).toBe('/home/l-paper')
  })

  it('drops a project bound only on the assistant host (by device row or by the cloud host id), keeps the same name elsewhere', () => {
    const devices = [device('cloud-host', { capabilities: { assistant_home: true } as Device['capabilities'], projects: [record('home')] }), device('laptop', { projects: [record('l1')] })]
    const list = [project('chat-home', '助理', [['cloud-host', 'home']]), project('chat-l1', '助理', [['laptop', 'l1']]), project('chat-x', 'x', [['cloud-x', 'x1']])]
    expect(phoneProjectRows(list, devices, homeOf(null)).map(row => row.id)).toEqual(['chat-l1', 'chat-x'])
    expect(phoneProjectRows(list, devices, homeOf('cloud-x')).map(row => row.id)).toEqual(['chat-l1'])
  })

  it('does not mutate the published account records', () => {
    const devices = [device('laptop', { projects: [record('l1')] })]
    const before = JSON.stringify(devices)
    phoneProjectRows([project('chat-l1', 'Paper', [['laptop', 'l1']])], devices, homeOf(null))
    expect(JSON.stringify(devices)).toBe(before)
  })

  it('marks the folders of a machine whose projects this end could not read (projects_error) as stale', () => {
    const [row] = phoneProjectRows([project('chat-paper', 'Paper', [['laptop', 'l-paper'], ['desk', 'd-paper']])],
      [device('laptop', { projects: [record('l-paper')] }), device('desk', { projects: [record('d-paper')], is_online: false, projects_error: 'permission denied' })], homeOf(null))
    expect(row!.stale).toBe(true)
    expect(row!.folders.map(folder => [folder.path, folder.stale])).toEqual([['/home/l-paper', false], ['/home/d-paper', true]])
  })
})
