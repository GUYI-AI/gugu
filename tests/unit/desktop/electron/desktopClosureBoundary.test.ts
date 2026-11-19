import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { registerDesktopClosureIpc } from '../../../../apps/desktop/electron/account-closure/ipc'
import { createClosureAuthBarrier } from '../../../../apps/desktop/electron/account-closure/auth-barrier'
import { removeClosureOwnerDirectory } from '../../../../apps/desktop/electron/account-closure/owner-directory'
import { nativeDesktopAccountClosure } from '../../../../apps/desktop/src/platform/desktopAccountClosure'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }) })
describe('native closure boundary', () => {
  it('removes only the exact native A directory and retains the adjacent B directory', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'closure-owner-')); roots.push(root)
    for (const owner of [A, B]) { await mkdir(join(root, owner)); await writeFile(join(root, owner, 'data'), owner) }
    await removeClosureOwnerDirectory(root, A)
    await expect(readFile(join(root, A, 'data'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, B, 'data'), 'utf8')).toBe(B)
    await expect(removeClosureOwnerDirectory(root, '../' + B)).rejects.toThrow('Invalid cleanup owner')
  })
  it('refuses an owner-directory alias and leaves its target intact', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'closure-alias-')); roots.push(root)
    await mkdir(join(root, B)); await writeFile(join(root, B, 'data'), 'keep')
    await symlink(join(root, B), join(root, A), 'dir')
    await expect(removeClosureOwnerDirectory(root, A)).rejects.toThrow('alias')
    expect(await readFile(join(root, B, 'data'), 'utf8')).toBe('keep')
  })
  it('rejects another WebContents and a child frame before touching receipt storage', async () => {
    let handler!: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
    const mainFrame = {}, contents = { mainFrame }, service = vi.fn()
    const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
    registerDesktopClosureIpc({ handle: (_channel, callback) => { handler = callback } }, () => window, service)
    for (const event of [{ sender: { mainFrame }, senderFrame: mainFrame }, { sender: contents, senderFrame: {} }]) {
      expect(await handler(event as IpcMainInvokeEvent, { type: 'get', scope: { ownerId: A, localOperationId: 'opaque' } }))
        .toEqual({ ok: false, code: 'wrong_local_owner' })
    }
    expect(service).not.toHaveBeenCalled()
  })
  it('does not expose native transport error details or accept a malformed successful erase reply', async () => {
    const invoke = vi.fn(async (): Promise<unknown> => { throw new Error('private-path receipt=secret') })
    vi.stubGlobal('window', { electronAPI: { invoke } })
    const scope = { ownerId: A, localOperationId: 'opaque' }
    await expect(nativeDesktopAccountClosure.receipt.get(scope)).rejects.toMatchObject({ code: 'closure_storage_unavailable', message: 'closure_storage_unavailable' })
    invoke.mockResolvedValue({ ok: true, value: { status: 'complete', retainedUnattributed: ['private/value'] } })
    await expect(nativeDesktopAccountClosure.eraseLocal(scope)).rejects.toMatchObject({ code: 'closure_storage_unavailable' })
  })
  it('serializes unrelated auth writes while allowing internal receipt calls to re-enter', async () => {
    const barrier = createClosureAuthBarrier(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const events: string[] = []
    const first = barrier(async () => {
      await barrier(async () => { events.push('native-capture') })
      entered.resolve(); await release.promise; events.push('capture-saved')
    })
    await entered.promise
    const second = barrier(async () => { events.push('auth-replaced') })
    expect(events).toEqual(['native-capture'])
    release.resolve(); await first; await second
    expect(events).toEqual(['native-capture', 'capture-saved', 'auth-replaced'])
  })
  it('does not let an async descendant reuse a closed barrier ticket', async () => {
    const barrier = createClosureAuthBarrier(), childGo = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const events: string[] = []
    let child!: Promise<void>
    await barrier(async () => { child = childGo.promise.then(() => barrier(async () => { events.push('late-child') })) })
    const held = barrier(async () => { entered.resolve(); await release.promise; events.push('current-auth') })
    await entered.promise; childGo.resolve(); await Promise.resolve()
    expect(events).toEqual([])
    release.resolve(); await held; await child
    expect(events).toEqual(['current-auth', 'late-child'])
  })
})
