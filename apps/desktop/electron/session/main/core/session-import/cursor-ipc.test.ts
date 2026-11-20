import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'
import { externalImportChannels as channels } from '../../../../../src/session/shared/core/session-import/external-conversation-import'
const deps = vi.hoisted(() => ({ run: vi.fn(), has: vi.fn(() => false), importRow: vi.fn(), list: vi.fn(() => []) }))
vi.mock('electron', () => ({ app: { getPath: () => '/isolated-profile', on: vi.fn() }, dialog: {} }))
vi.mock('../../../../external-import/cursor-process', () => ({ runCursorProcess: deps.run }))
vi.mock('../../../../external-import/store', () => ({ ExternalHistoryStore: class { has = deps.has; import = deps.importRow; list = deps.list } }))
vi.mock('../../worker-manifest', () => ({ desktopWorkerPath: () => '/cursor-worker.js' }))
import { registerExternalImportIpc } from '../../../../external-import/ipc'

beforeEach(() => { vi.clearAllMocks() })
function setup() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const sender = { mainFrame: {} }
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  let owner = 'owner-a'
  const host = registerExternalImportIpc({
    ipc: { handle: (id: string, fn: (...args: any[]) => any) => handlers.set(id, fn) } as unknown as IpcMain,
    getWindow: () => ({ webContents: sender }) as unknown as BrowserWindow,
    getOwner: () => owner,
  })
  return { call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args), switchOwner: () => { owner = 'owner-b'; host.ownerChanged() } }
}
const selected = { rows: [{ sourceId: 'one', title: 'Title' }], failed: 0 }

it('shares summary scans and imports without transferring bodies to the main store', async () => {
  let finish!: (value: unknown) => void
  deps.run.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const host = setup()
  const scans = [host.call(channels.scan), host.call(channels.scan)]
  expect(deps.run).toHaveBeenCalledTimes(1)
  finish({ action: 'scan', result: selected })
  expect(await Promise.all(scans)).toEqual([{ count: 1, pending: false }, { count: 1, pending: false }])
  const { id } = host.call(channels.start)
  const batch = { imported: [{ sessionId: 'new', title: 'Title', projectId: null, importedAt: 1 }], failed: 0, alreadyImported: 0, done: 1, total: 1 }
  deps.run.mockResolvedValueOnce({ action: 'import', result: batch })
  expect(await host.call(channels.next, id)).toEqual(batch)
  expect(deps.importRow).not.toHaveBeenCalled()
  expect(deps.run.mock.calls[1][1]).toMatchObject({ action: 'import', owner: 'owner-a', directory: '/isolated-profile/external-conversation-history' })
})

it('aborts old-owner scans and does not publish their results into the new account', async () => {
  let finish!: (value: unknown) => void
  deps.run.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const host = setup()
  const scan = host.call(channels.scan)
  const signal = deps.run.mock.calls[0][2] as AbortSignal
  host.switchOwner()
  expect(signal.aborted).toBe(true)
  finish({ action: 'scan', result: selected })
  expect(await scan).toBeNull()
  expect(() => host.call(channels.start)).toThrow('No conversation source')
})

it('cancel aborts the in-flight import and rejects its late reply', async () => {
  deps.run.mockResolvedValueOnce({ action: 'scan', result: selected })
  const host = setup()
  await host.call(channels.scan)
  const { id } = host.call(channels.start)
  let finish!: (value: unknown) => void
  deps.run.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = host.call(channels.next, id)
  const signal = deps.run.mock.calls[1][2] as AbortSignal
  host.call(channels.cancel, id)
  expect(signal.aborted).toBe(true)
  finish({ action: 'import', result: { done: 1, total: 1 } })
  await expect(pending).rejects.toThrow('Import is unavailable')
})

it('keeps ChatGPT export history from the retired import listable without scanning a source', async () => {
  const host = setup()
  host.call(channels.list, 'chatgpt')
  expect(deps.list).toHaveBeenCalledWith('owner-a', 'chatgpt')
  expect(deps.run).not.toHaveBeenCalled()
})
