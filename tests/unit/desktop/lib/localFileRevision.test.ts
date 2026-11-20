import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localFileRevision, metadataForFile, requestFile, resolveFile } from '../../../../apps/desktop/src/lib/fileAccess'
import { FileReadRevokedError } from '@gugu/core/shared/fileResolver'
import type { NativeFileReadCommand, NativeFileReadIpc } from '../../../../apps/desktop/electron/nativeFileHost'
const f = vi.hoisted(() => ({ call: vi.fn(), state: vi.fn(), off: vi.fn(), fetch: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: 'owner' } }), getRendererAccessToken: () => 'fixture-token', observeRendererSession: () => () => {} }))
const revision = { source: 'local', item_id: 'item', version: 1, chat_id: 'group', file_name: 'file.bin', size_bytes: 0, sha256: 'ab'.repeat(32), content_type: 'application/octet-stream', host_account_id: 'owner', host_device_id: 'device', host_project_id: 'project', relative_path: 'file.bin' }
const actor = { accountId: 'owner', actorId: 'owner' }, ref = { item_id: 'item' }
beforeEach(() => {
  vi.resetAllMocks()
  f.call.mockResolvedValue(undefined)
  f.state.mockReturnValue(f.off)
  vi.stubGlobal('window', { electronAPI: { fileRead: f.call, onFileReadState: f.state } })
  vi.stubGlobal('fetch', f.fetch)
  f.fetch.mockRejectedValue(new Error('No cloud request allowed'))
})
afterEach(() => { vi.unstubAllGlobals() })
describe('local file UI metadata uses the existing resolver without byte or cloud acquisition', () => {
  it('returns local placement and releases the handle without reading bytes', async () => {
    f.call.mockResolvedValueOnce({ status: 'ready', revision })
    await expect(localFileRevision('item')).resolves.toEqual(revision)
    const id = f.call.mock.calls[0]![0].id
    expect(f.call.mock.calls.map(([command]) => command)).toEqual([
      { op: 'resolve', id, ref, actor, purpose: undefined, localOnly: true }, { op: 'dispose', id, ref, actor },
    ])
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('a local miss does not fetch remote metadata, sign or acquire bytes', async () => {
    f.call.mockResolvedValueOnce(null)
    await expect(localFileRevision('cloud-item')).resolves.toBeNull()
    expect(f.call.mock.calls.map(([command]) => command.op)).not.toContain('read')
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('a browser has no local disk provider and does not invoke or fetch', async () => {
    vi.stubGlobal('window', {})
    await expect(localFileRevision('cloud-item')).resolves.toBeNull()
    expect(f.call).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })
  it('preserves main’s refusal of local authority without falling back to cloud', async () => {
    f.call.mockRejectedValueOnce(new Error('Invalid local file revision'))
    await expect(localFileRevision('item')).rejects.toThrow()
    expect(f.fetch).not.toHaveBeenCalled()
  })
})

it('metadata stays a single lookup even for a pending attachment', async () => {
  f.call.mockResolvedValueOnce({ status: 'pending', sha256: null })
  await expect(metadataForFile(ref, actor)).resolves.toEqual({ status: 'pending', sha256: null })
  expect(f.call).toHaveBeenCalledExactlyOnceWith({ op: 'metadata', id: expect.any(String), ref, actor })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('filters IPC states by waiter and aborts only the corresponding pending request', async () => {
  let finish!: (value: unknown) => void
  const state = vi.fn(), controller = new AbortController()
  f.call.mockImplementation((command: NativeFileReadCommand) => command.op === 'request' ? new Promise(resolve => { finish = resolve }) : Promise.resolve())
  const result = requestFile(ref, actor, { purpose: 'save', signal: controller.signal }, state)
  const id = f.call.mock.calls[0]![0].id
  const notify: Parameters<NativeFileReadIpc['onFileReadState']>[0] = f.state.mock.calls[0]![0]
  const waiting = { status: 'waiting_sender', reason: 'declared' } as const
  notify({ id: 'foreign', state: waiting })
  notify({ id, state: waiting })
  expect(state).toHaveBeenCalledExactlyOnceWith(waiting)
  controller.abort(new Error('left preview'))
  finish({ revision })
  await expect(result).rejects.toThrow('left preview')
  expect(f.call.mock.calls.map(([command]) => command)).toEqual([
    { op: 'request', purpose: 'save', id, ref, actor }, { op: 'cancel', id, ref, actor },
  ])
  expect(f.off).toHaveBeenCalledOnce()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('keeps preview content a separate capability and renews a signed video on the same handle', async () => {
  f.call.mockResolvedValueOnce({ status: 'ready', revision: { ...revision, source: 'managed-object', content_type: 'video/mp4' } })
    .mockResolvedValueOnce({ url: 'https://media.test/first', expiresAt: 1 })
    .mockResolvedValueOnce({ url: 'https://media.test/renewal', expiresAt: 2 })
  const file = await resolveFile(ref, actor, { purpose: 'preview' })
  if (file.status !== 'ready') throw new Error('Expected a preview handle')
  expect(await file.content()).toEqual({ url: 'https://media.test/first', expiresAt: 1 })
  expect(await file.content()).toEqual({ url: 'https://media.test/renewal', expiresAt: 2 })
  await file.dispose()
  const commands = f.call.mock.calls.map(([command]) => command)
  expect(commands.map(command => command.op)).toEqual(['resolve', 'preview', 'preview', 'dispose'])
  expect(new Set(commands.map(command => command.id)).size).toBe(1)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('restores revocation across Electron’s invoke error boundary', async () => {
  f.call.mockResolvedValueOnce({ revision })
    .mockRejectedValueOnce(new Error('Error invoking remote method files:read\ngugu-file-error {"kind":"revoked","reason":"revision"}'))
  const file = await requestFile(ref, actor, { purpose: 'show' })
  await expect(file.acknowledgement?.()).rejects.toBeInstanceOf(FileReadRevokedError)
  await file.dispose()
})
