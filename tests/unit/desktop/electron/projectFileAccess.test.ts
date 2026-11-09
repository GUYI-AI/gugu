import { createHash } from 'node:crypto'
// The store's fallbacks need a link or a rename to fail on a filesystem that would not fail them.
const fsHooks = vi.hoisted(() => ({} as { link?: (from: string, to: string) => Promise<void>; rename?: (from: string, to: string) => Promise<void> }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs,
    link: (from: string, to: string) => (fsHooks.link ?? fs.link)(from, to),
    rename: (from: string, to: string) => (fsHooks.rename ?? fs.rename)(from, to),
    __actualRename: fs.rename }
})
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileResolver, type FileProviders, type FileRevision } from '../../../../packages/core/src/shared/fileResolver'
import { ciphertextSize, createFileKey, transformFile } from '../../../../packages/core/src/shared/fileCipher'
import { createProjectTransferHost } from '../../../../apps/desktop/electron/projectFileTransferHost'
import { createFileChunkCache, createFileSink } from '../../../../apps/desktop/electron/fileSnapshot'
import { createNodeFileResolver, saveFileHandle, saveToFileStore } from '@gugu/core/local/files/fileSnapshots'
import { createProjectFileReader, localProjectFileProvider, openProjectFileSource, snapshotProjectFile } from '../../../../apps/desktop/electron/projectFileHost'
import { ownSshFileProvider } from '../../../../apps/desktop/electron/projectFileSsh'
import { createDesktopFileAccess } from '../../../../apps/desktop/electron/desktopFileAccess'
import { deviceFile, writeDeviceIdCache } from '@gugu/core/cloud/deviceRuntime'
import { forgetProjectFile, forgetProjectGroupId, readProjectFile, rememberProjectFile, rememberProjectGroupId } from '../../../../apps/desktop/electron/sessionpage/sessionpage-project-groups'

const { __actualRename: actualRename } = await import('node:fs/promises') as unknown as { __actualRename: (from: string, to: string) => Promise<void> }
let home: string, root: string, tempRoot: string, env: NodeJS.ProcessEnv
let accountId: string, revision: FileRevision
const bytes = Buffer.alloc(700_001, 83)
const ref = { item_id: 'item', version: 1 }
const actor = { accountId: 'owner', actorId: 'owner' }
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const identity = async () => ({ accountId, deviceId: 'host-device' })
const reader = () => createProjectFileReader({ identity, root: async id => id === 'project' ? root : null, env })

describe('downloads consume one file without the random-read cache', () => {
  const remote = (content: Uint8Array = bytes) => {
    const stored = { ...revision, source: 'managed-object' as const }
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/file-resolve')) return Response.json({ status: 'ready', ...stored })
      if (String(url).endsWith('/file-download')) return Response.json({ status: 'ready', url: 'https://objects.invalid/file', size_bytes: stored.size_bytes, sha256: stored.sha256, download_id: 'download' })
      if (String(url) === 'https://objects.invalid/file') return new Response(content as Uint8Array<ArrayBuffer>)
      throw new Error('Unexpected file request')
    })
    return { resolve: createNodeFileResolver(tempRoot, async () => ({ supabaseUrl: 'https://files.invalid', anonKey: 'public', token: 'test', fetch: fetcher as typeof fetch })), fetcher }
  }
  it('two agents saving one new file into the store both succeed, and no private name is left', async () => {
    const { resolve } = remote()
    const save = async () => {
      const file = await resolve(ref, actor)
      if (file.status !== 'ready') throw new Error(file.status)
      return saveToFileStore(file, home, 'report.bin')
    }
    const [a, b] = await Promise.all([save(), save()])
    expect(a.file_path).toBe(b.file_path)
    expect(await readdir(join(home, 'file-store', revision.sha256!))).toEqual(['report.bin'])
    expect(digest(await readFile(a.file_path))).toBe(revision.sha256)
  })
  it('stores one sha once: read-only, a second name is the same bytes, and a changed file is fetched again', async () => {
    const { resolve, fetcher } = remote()
    const store = join(home, 'file-store')
    const saveAs = async (name: string) => {
      const file = await resolve(ref, actor)
      if (file.status !== 'ready') throw new Error(file.status)
      return saveToFileStore(file, home, name)
    }
    const first = await saveAs('report.bin')
    const second = await saveAs('renamed.bin')
    expect(fetcher.mock.calls.filter(([url]) => String(url) === 'https://objects.invalid/file')).toHaveLength(1)
    const [a, b] = await Promise.all([stat(first.file_path), stat(second.file_path)])
    expect(a.ino).toBe(b.ino)
    expect(a.mode & 0o777).toBe(0o444)
    expect(await readdir(join(store, revision.sha256!))).toEqual(['renamed.bin', 'report.bin'])
    expect(first.read_only).toBe(true)
    // An agent that forced a write changes both names, they are one file. Neither is handed out as this version, and the
    // edit is kept, moved aside.
    await chmod(first.file_path, 0o644)
    const edit = Buffer.alloc(bytes.length, 1)
    await writeFile(first.file_path, edit)
    const healed = await saveAs('report.bin')
    expect(digest(await readFile(healed.file_path))).toBe(revision.sha256)
    expect((await stat(healed.file_path)).mode & 0o777).toBe(0o444)
    expect(await readdir(join(store, revision.sha256!))).toEqual(['report.bin'])
    const aside = await readdir(join(store, '.changed'))
    expect(aside).toHaveLength(2)
    const kept = await Promise.all(aside.map(async id => { const [name] = await readdir(join(store, '.changed', id)); return readFile(join(store, '.changed', id, name!)) }))
    for (const file of kept) expect(file.equals(edit)).toBe(true)
  })
  it('a second name is its own stored copy where hard links are unavailable', async () => {
    const { resolve } = remote()
    fsHooks.link = async () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }) }
    const saveAs = async (name: string) => {
      const file = await resolve(ref, actor)
      if (file.status !== 'ready') throw new Error(file.status)
      return saveToFileStore(file, home, name)
    }
    const [a, b] = [await saveAs('one.bin'), await saveAs('two.bin')]
    const [x, y] = await Promise.all([stat(a.file_path), stat(b.file_path)])
    expect(x.ino).not.toBe(y.ino)
    expect([x.mode & 0o777, y.mode & 0o777]).toEqual([0o444, 0o444])
    expect(digest(await readFile(b.file_path))).toBe(revision.sha256)
    expect((await readdir(join(home, 'file-store', revision.sha256!))).sort()).toEqual(['one.bin', 'two.bin'])
  })
  it('where hard links are unavailable and another save got there first, the rename refused onto it is still a success', async () => {
    const { resolve } = remote()
    const path = join(home, 'file-store', revision.sha256!, 'report.bin')
    fsHooks.link = async () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }) }
    fsHooks.rename = async (from, to) => {
      if (to !== path) return actualRename(from, to)
      await writeFile(path, bytes)
      throw Object.assign(new Error('read-only target'), { code: 'EPERM' })
    }
    const file = await resolve(ref, actor)
    if (file.status !== 'ready') throw new Error(file.status)
    const saved = await saveToFileStore(file, home, 'report.bin')
    expect(digest(await readFile(saved.file_path))).toBe(revision.sha256)
    expect((await stat(saved.file_path)).mode & 0o777).toBe(0o444)
    expect(await readdir(join(home, 'file-store', revision.sha256!))).toEqual(['report.bin'])
  })
  const savedTo = async (resolve: ReturnType<typeof remote>['resolve'], name: string) => {
    const file = await resolve(ref, actor)
    if (file.status !== 'ready') throw new Error(file.status)
    return saveToFileStore(file, home, name)
  }
  const asideFiles = async () => {
    const root = join(home, 'file-store', '.changed')
    return Promise.all((await readdir(root)).map(async id => readFile(join(root, id, (await readdir(join(root, id)))[0]!))))
  }
  it.each([['a link', 'EEXIST'], ['a rename, without hard links', 'EPERM']])('a changed file that appears at the name while it saves is moved aside by %s', async (_, code) => {
    const { resolve } = remote()
    const edit = Buffer.alloc(bytes.length, 1)
    fsHooks.link = async (_from, to) => {
      if (code === 'EEXIST') delete fsHooks.link
      await writeFile(to, edit)
      throw Object.assign(new Error('link'), { code })
    }
    const saved = await savedTo(resolve, 'report.bin')
    expect(digest(await readFile(saved.file_path))).toBe(revision.sha256)
    expect((await stat(saved.file_path)).mode & 0o777).toBe(0o444)
    const aside = await asideFiles()
    expect(aside).toHaveLength(1)
    expect(aside[0]!.equals(edit)).toBe(true)
  })
  it('where hard links are unavailable and another save already finished this name, the save succeeds on its file', async () => {
    const { resolve } = remote()
    fsHooks.link = async (_from, to) => {
      await writeFile(to, bytes)
      throw Object.assign(new Error('no links'), { code: 'EPERM' })
    }
    const saved = await savedTo(resolve, 'report.bin')
    expect(digest(await readFile(saved.file_path))).toBe(revision.sha256)
    expect((await stat(saved.file_path)).mode & 0o777).toBe(0o444)
    expect(await readdir(dirname(saved.file_path))).toEqual(['report.bin'])
    expect(await stat(join(home, 'file-store', '.changed')).catch(() => null)).toBeNull()
  })
  it('a changed name that cannot move holds back only its own hand-out', async () => {
    const { resolve } = remote()
    const first = await savedTo(resolve, 'report.bin')
    const locked = await savedTo(resolve, 'locked.bin')
    await chmod(first.file_path, 0o644)
    await writeFile(first.file_path, Buffer.alloc(bytes.length, 1))
    fsHooks.rename = async (from, to) => {
      if (from === locked.file_path) throw Object.assign(new Error('open elsewhere'), { code: 'EBUSY' })
      return actualRename(from, to)
    }
    expect(digest(await readFile((await savedTo(resolve, 'report.bin')).file_path))).toBe(revision.sha256)
    expect((await readdir(dirname(locked.file_path))).sort()).toEqual(['locked.bin', 'report.bin'])
    await expect(savedTo(resolve, 'locked.bin')).rejects.toThrow('open elsewhere')
  })
  it('hands out a name read-only again when only its flag was cleared', async () => {
    const { resolve } = remote()
    const first = await savedTo(resolve, 'report.bin')
    await chmod(first.file_path, 0o644)
    expect((await stat((await savedTo(resolve, 'report.bin')).file_path)).mode & 0o777).toBe(0o444)
    await chmod(first.file_path, 0o644)
    const second = await savedTo(resolve, 'renamed.bin')
    expect((await stat(second.file_path)).mode & 0o777).toBe(0o444)
    expect((await stat(second.file_path)).ino).toBe((await stat(first.file_path)).ino)
  })
  it('writes one authenticated destination, reuses its verified digest, and leaves no remote-files chunks or snapshot', async () => {
    const { resolve, fetcher } = remote()
    const save = async () => {
      const file = await resolve(ref, actor)
      if (file.status !== 'ready') throw new Error('Missing fixture')
      return saveFileHandle(file, join(home, 'attachments'), 'file.bin')
    }
    const [first, concurrent] = await Promise.all([save(), save()])
    expect(first.file_path).toBe(concurrent.file_path)
    expect(await readFile(first.file_path)).toEqual(bytes)
    expect(await readdir(join(home, 'attachments', revision.sha256!))).toEqual(['file.bin'])
    expect(await stat(tempRoot).catch(() => null)).toBeNull()
    const gets = fetcher.mock.calls.filter(([url]) => String(url) === 'https://objects.invalid/file').length
    await save()
    expect(fetcher.mock.calls.filter(([url]) => String(url) === 'https://objects.invalid/file')).toHaveLength(gets)
  })
  it('removes the partial on a digest mismatch and never publishes corrupted content', async () => {
    const { resolve } = remote(Buffer.alloc(bytes.length, 9))
    const file = await resolve(ref, actor)
    if (file.status !== 'ready') throw new Error('Missing fixture')
    await expect(saveFileHandle(file, join(home, 'attachments'), 'file.bin')).rejects.toThrow('SHA-256')
    expect(await stat(join(home, 'attachments', revision.sha256!)).catch(() => null)).toBeNull()
    expect(await stat(tempRoot).catch(() => null)).toBeNull()
  })

  it.each([false, true])('authenticates encrypted downloads before publishing, including revoked access=%s', async revoked => {
    const stored = { ...revision, temporary_transfer: true }, key = await createFileKey(), chunks: Uint8Array[] = []
    const source = { size: bytes.length, read: async (offset: number, length: number) => bytes.subarray(offset, offset + length), dispose: async () => {} }
    const encrypted = await transformFile({ direction: 'encrypt', revision: stored, source, key, sink: {
      write: async chunk => { chunks.push(chunk) }, abort: async () => {},
      commit: async () => ({ size: ciphertextSize(bytes.length), read: async () => new Uint8Array(), dispose: async () => {} }),
    } })
    const cipher = Buffer.concat(chunks), destination = join(home, 'attachments', revision.sha256!), routes: string[] = []
    let resolutions = 0
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const route = String(url).split('/').at(-1)!
      routes.push(route)
      if (route === 'file-resolve') {
        if (++resolutions === 2) {
          expect((await readdir(destination)).every(name => name.endsWith('.part'))).toBe(true)
          if (revoked) return Response.json({ error: 'denied', message: 'Access revoked' }, { status: 403 })
        }
        return Response.json({ status: 'ready', ...stored })
      }
      if (route === 'file-request') return Response.json({ status: 'ready', transfer_status: 'ready' })
      if (route === 'file-download') return Response.json({ status: 'ready', url: 'https://objects.invalid/encrypted', size_bytes: cipher.length,
        sha256: stored.sha256, download_id: 'encrypted', ciphertext_bytes: cipher.length, ciphertext_sha256: encrypted.ciphertextSha256,
        codec: 'secretstream-v1', key: Buffer.from(key).toString('base64') })
      if (route === 'encrypted') return new Response(cipher)
      if (route === 'file-read-complete') return Response.json({ status: 'ready' })
      throw new Error('Unexpected file request')
    })
    const resolve = createNodeFileResolver(tempRoot, async () => ({ supabaseUrl: 'https://files.invalid', anonKey: 'public', token: 'test', fetch: fetcher as typeof fetch }))
    const file = await resolve(ref, actor)
    if (file.status !== 'ready') throw new Error('Missing fixture')
    try {
      const saving = saveFileHandle(file, join(home, 'attachments'), 'file.bin')
      if (revoked) {
        await expect(saving).rejects.toThrow('Access revoked')
        expect(await stat(destination).catch(() => null)).toBeNull()
        expect(routes).not.toContain('file-read-complete')
      } else {
        expect(await readFile((await saving).file_path)).toEqual(bytes)
        expect(await readdir(destination)).toEqual(['file.bin'])
        expect(routes).toContain('file-read-complete')
      }
      expect(await stat(tempRoot).catch(() => null)).toBeNull()
    } finally { key.fill(0) }
  })

  it('removes the partial when cancellation arrives during the object read', async () => {
    const controller = new AbortController(), stored = { ...revision, source: 'managed-object' as const }
    const resolve = createNodeFileResolver(tempRoot, async () => ({ supabaseUrl: 'https://files.invalid', anonKey: 'public', token: 'test',
      fetch: async url => {
        if (String(url).endsWith('/file-resolve')) return Response.json({ status: 'ready', ...stored })
        if (String(url).endsWith('/file-download')) return Response.json({ status: 'ready', url: 'https://objects.invalid/file', size_bytes: stored.size_bytes, sha256: stored.sha256, download_id: 'download' })
        return new Response(new ReadableStream({ pull(stream) { controller.abort(new Error('cancelled')); stream.enqueue(bytes); stream.close() } }))
      } }))
    const file = await resolve(ref, actor, { signal: controller.signal })
    if (file.status !== 'ready') throw new Error('Missing fixture')
    await expect(saveFileHandle(file, join(home, 'attachments'), 'file.bin')).rejects.toThrow('cancelled')
    expect(await stat(join(home, 'attachments', revision.sha256!)).catch(() => null)).toBeNull()
  })
})
beforeEach(async () => {
  delete fsHooks.link; delete fsHooks.rename
  home = await mkdtemp(join(tmpdir(), 'gugu-project-file-access-'))
  root = join(home, 'project'); tempRoot = join(home, 'snapshots')
  env = { GUGU_HOME: home }; accountId = 'owner'
  await mkdir(root); await writeFile(join(root, 'file.bin'), bytes)
  revision = { source: 'local', item_id: 'item', version: 1, chat_id: 'group', file_name: 'file.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: digest(bytes), host_account_id: 'owner', host_device_id: 'host-device', host_project_id: 'project', relative_path: 'file.bin' }
  await rememberProjectGroupId('project', 'group', 'owner', env)
  await rememberProjectFile(revision, 'owner', env)
})
afterEach(async () => {
  const path = home
  console.log('Removing own project file fixture:', path)
  if (!path.startsWith(join(tmpdir(), 'gugu-project-file-access-'))) throw Error('Unexpected fixture path')
  await rm(path, { recursive: true, force: true })
})

describe('account/project revision index', () => {
  it('stores no absolute root and partitions account, device, version and binding', async () => {
    expect(await readProjectFile(ref, 'owner', 'host-device', env)).toEqual(revision)
    for (const [owner, device, version] of [['other', 'host-device', 1], ['owner', 'other-device', 1], ['owner', 'host-device', 2]] as const) {
      expect(await readProjectFile({ ...ref, version }, owner, device, env)).toBeNull()
    }
    const mapping = await readFile(join(home, 'taskpage-project-groups.json'), 'utf8')
    expect(mapping).not.toContain(root)
    await rememberProjectGroupId('project', 'other-group', 'owner', env)
    expect(await readProjectFile(ref, 'owner', 'host-device', env)).toBeNull()
  })
  it('serializes concurrent index writes with group writes, and forget invalidates', async () => {
    await Promise.all(Array.from({ length: 4 }, (_, n) => rememberProjectFile({ ...revision, item_id: `item-${n}` }, 'owner', env)))
    for (let n = 0; n < 4; n++) expect(await readProjectFile({ item_id: `item-${n}`, version: 1 }, 'owner', 'host-device', env)).not.toBeNull()
    await forgetProjectFile('item-0', 'owner', env)
    expect(await readProjectFile({ item_id: 'item-0', version: 1 }, 'owner', 'host-device', env)).toBeNull()
    await forgetProjectGroupId('project', 'owner', env)
    expect(await readProjectFile(ref, 'owner', 'host-device', env)).toBeNull()
  })
  it.each(['../secret', '/absolute', 'file/../secret', 'C:\\secret', 'a\u0000b'])('rejects unsafe path %j at publication and cache read', async relative_path => {
    await expect(rememberProjectFile({ ...revision, relative_path }, 'owner', env)).rejects.toThrow()
    const path = join(home, 'taskpage-project-groups.json')
    const mapping = JSON.parse(await readFile(path, 'utf8'))
    mapping.files.owner.item.relative_path = relative_path
    await writeFile(path, JSON.stringify(mapping))
    await expect(readProjectFile(ref, 'owner', 'host-device', env)).rejects.toThrow('Invalid local file revision')
  })
  it('does not admit an unbound or foreign-owner revision', async () => {
    await expect(rememberProjectFile({ ...revision, host_account_id: 'other' }, 'owner', env)).rejects.toThrow()
    await expect(rememberProjectFile({ ...revision, chat_id: 'other' }, 'owner', env)).rejects.toThrow('binding changed')
    await expect(rememberProjectFile({ ...revision, chat_id: undefined }, 'owner', env)).rejects.toThrow()
  })
})

describe('a later version the database made from the same bytes (#719: a rename or move)', () => {
  // The index still holds version 1; the database's record of version 2 names the same bytes under a new name.
  const renamed = () => ({ ...revision, version: 2, file_name: 'renamed.bin' })
  it('reads version 2 as the same bytes, under its new name, and keeps reading the named version 1 without asking', async () => {
    const later = vi.fn(async () => renamed())
    expect(await readProjectFile({ ...ref, version: 2 }, 'owner', 'host-device', env, later)).toEqual({ ...revision, version: 2, file_name: 'renamed.bin' })
    expect(later).toHaveBeenCalledWith({ item_id: 'item', version: 2 })
    later.mockClear()
    expect(await readProjectFile(ref, 'owner', 'host-device', env, later)).toEqual(revision)
    expect(later).not.toHaveBeenCalled()
    // No version named: the current one, which the database says is version 2, the same bytes here.
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'host-device', env, later)).toEqual({ ...revision, version: 2, file_name: 'renamed.bin' })
    expect(later).toHaveBeenCalledWith({ item_id: 'item' })
    const provider = localProjectFileProvider({ identity, read: createProjectFileReader({ identity, root: async () => root, env, later }), tempRoot, env, later })
    const file = await createFileResolver({ local: provider, metadata: later as never, managed: later as never, ssh: later as never, temporary: later as never })({ ...ref, version: 2 }, actor)
    if (file.status !== 'ready') throw Error('ready expected')
    expect(file.revision).toMatchObject({ version: 2, file_name: 'renamed.bin' })
    expect(await file.read(500_000, 2)).toEqual(new Uint8Array([83, 83]))
    await file.dispose()
  })
  it('the composition root asks the database for that version as the owner', async () => {
    await writeDeviceIdCache(deviceFile(env, 'owner'), 'host-device')
    const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/functions\/v1\/attachments\/file-resolve$/)
      expect(JSON.parse(String(init?.body))).toEqual({ ref: { item_id: 'item', version: 2 }, as: 'owner' })
      return Response.json({ ...renamed(), status: 'ready' })
    })
    const access = createDesktopFileAccess({ auth: async () => ({ userId: 'owner', accessToken: 'memory-only-token' }), root: async () => root, links: () => null, tempRoot, downloads: join(home, 'downloads'), fetch: network as typeof fetch, rpc: network as never, env, deviceStore: join(home, 'project-files'), identityDb: network as never })
    const file = await access.resolveAccount({ id: 'item' }, null, { version: 2, localOnly: true })
    if (file?.status !== 'ready') throw Error('ready expected')
    expect(file.revision.file_name).toBe('renamed.bin')
    expect(await file.read(0, 2)).toEqual(new Uint8Array([83, 83]))
    await file.dispose()
  })
  it.each([
    ['another path', { relative_path: 'other.bin' }], ['other bytes', { sha256: 'ab'.repeat(32) }], ['another size', { size_bytes: 7 }],
    ['another computer', { host_device_id: 'other-device' }], ['another project', { host_project_id: 'other' }], ['another chat', { chat_id: 'other' }],
    ['another version', { version: 3 }], ['bytes in the cloud', { source: 'managed-object' }],
  ] as const)('refuses when the database names %s', async (_, change) => {
    expect(await readProjectFile({ ...ref, version: 2 }, 'owner', 'host-device', env, async () => ({ ...renamed(), ...change }) as FileRevision)).toBeNull()
  })
  // A project chat has no host: another member's device may write the next version, which it then keeps. The device that
  // kept version 1 must not answer for the file's current version with its own old bytes (native #107 cell 4).
  it('answers no version named only while this device keeps the current version; a named older version stays local', async () => {
    const elsewhere = vi.fn(async () => ({ ...revision, version: 2, host_device_id: 'other-device', relative_path: 'item/file.bin', sha256: 'cd'.repeat(32), size_bytes: 74 }) as FileRevision)
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'host-device', env, elsewhere)).toBeNull()
    expect(elsewhere).toHaveBeenCalledWith({ item_id: 'item' })
    expect(await readProjectFile(ref, 'owner', 'host-device', env, elsewhere)).toEqual(revision)
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'host-device', env, async () => revision)).toEqual(revision)
    expect(await readProjectFile({ item_id: 'item' }, 'owner', 'host-device', env)).toBeNull()
  })
  it('refuses a version the database does not have, and never asks about one older than the index', async () => {
    expect(await readProjectFile({ ...ref, version: 2 }, 'owner', 'host-device', env, async () => null)).toBeNull()
    await rememberProjectFile({ ...revision, version: 3 }, 'owner', env)
    const later = vi.fn(async () => renamed())
    expect(await readProjectFile({ ...ref, version: 2 }, 'owner', 'host-device', env, later)).toBeNull()
    expect(later).not.toHaveBeenCalled()
  })
})

describe('local read fence and verified snapshot', () => {
  it('the production composition root opens by item or folder path asking only which version is current, without bytes from the cloud, auth refresh or an SSH dial', async () => {
    await writeDeviceIdCache(deviceFile(env, 'owner'), 'host-device')
    await rememberProjectFile({ ...revision, workspace: { path: 'file.bin', parent_id: null, created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', created_by: 'owner', source_message_ids: [] } }, 'owner', env)
    // The one metadata question a current-version read asks: the database names this device's version 1 as current.
    const current = vi.fn(async (input: string | URL | Request) => {
      if (!/\/functions\/v1\/attachments\/file-resolve$/.test(String(input))) throw new Error('Unexpected network request')
      return Response.json({ ...revision, status: 'ready' })
    })
    const network = vi.fn(async () => { throw new Error('Unexpected network request') })
    const links = vi.fn(() => null)
    const access = createDesktopFileAccess({ auth: async () => ({ userId: accountId, accessToken: 'memory-only-token' }), root: async () => root, links, tempRoot, downloads: join(home, 'downloads'), fetch: current as typeof fetch, rpc: network, env, deviceStore: join(home, 'project-files'), identityDb: network as never })
    expect(access.handlers('realtime')).toEqual({})
    expect(Object.keys(access.handlers('ssh'))).toEqual(['file.read'])
    for (const named of [{ id: 'item' }, { chat: 'group', name: 'file.bin' }]) {
      const file = await access.resolveAccount(named, null, { localOnly: true })
      expect(file?.status).toBe('ready')
      if (file?.status !== 'ready') throw new Error('Expected local file')
      expect(file.revision.workspace?.path).toBe('file.bin')
      expect(await file.read(500_000, 2)).toEqual(new Uint8Array([83, 83]))
      await file.dispose()
    }
    expect(network).not.toHaveBeenCalled(); expect(links).not.toHaveBeenCalled()
    accountId = 'other'
    await expect(access.resolveAccount({ id: 'item' }, null, { localOnly: true })).rejects.toThrow('device.json missing')
    expect(network).not.toHaveBeenCalled()
  })
  it('persists only bounded raw chunks in the existing private cache across provider restarts', async () => {
    const key = 'ab'.repeat(32), first = createFileChunkCache(tempRoot)
    expect(await first.get(key, 0)).toBeNull()
    await first.put(key, 0, new Uint8Array([1, 2, 3]))
    const second = createFileChunkCache(tempRoot)
    expect(await second.get(key, 0)).toEqual(new Uint8Array([1, 2, 3]))
    expect((await stat(join(tempRoot, `open-${key}`))).mode & 0o777).toBe(0o700)
    expect((await stat(join(tempRoot, `open-${key}`, '0'))).mode & 0o777).toBe(0o600)
    for (const [badKey, index] of [['../project/file.bin', 0], [key, -1], [key, 0.5]] as const) {
      await expect(second.get(badKey, index)).rejects.toThrow('Invalid file cache key')
      await expect(second.put(badKey, index, new Uint8Array([7]))).rejects.toThrow('Invalid file cache key')
    }
    await expect(second.put(key, 1, new Uint8Array(524_289))).rejects.toThrow('Invalid file range')
    await writeFile(join(tempRoot, `open-${key}`, '1'), new Uint8Array(524_289))
    await expect(second.get(key, 1)).rejects.toThrow('Invalid file range')
    await second.clear(key); expect(await readdir(tempRoot)).toEqual([])
  })
  it('an agent reading by message gets the file on this disk, with no temporary transfer through the cloud', async () => {
    const read = createProjectFileReader({ identity, root: async () => root, env })
    const never = vi.fn(async () => { throw Error('Network must remain unused') })
    const providers: FileProviders = { local: localProjectFileProvider({ identity, read, tempRoot, env }), metadata: vi.fn(async () => ({ status: 'ready' as const, revision })), managed: never, ssh: never, temporary: never }
    const file = await createFileResolver(providers)({ message_id: 'message' }, { accountId, actorId: 'agent' })
    if (file.status !== 'ready') throw Error('ready expected')
    expect(await file.read(0, 2)).toEqual(new Uint8Array([83, 83]))
    await file.dispose()
    expect(never).not.toHaveBeenCalled()
  })
  it('resolves locally before cloud lookup, is lazy, and exposes immutable bytes without paths or writes', async () => {
    const read = vi.fn(reader())
    const never = vi.fn(async () => { throw Error('Network must remain unused') })
    const providers: FileProviders = { local: localProjectFileProvider({ identity, read, tempRoot, env }), metadata: never, managed: never, ssh: never, temporary: never }
    const file = await createFileResolver(providers)(ref, actor)
    expect(file.status).toBe('ready'); expect(read).not.toHaveBeenCalled(); expect(never).not.toHaveBeenCalled()
    if (file.status !== 'ready') throw Error('ready expected')
    expect(await file.read(500_000, 100)).toEqual(new Uint8Array(bytes.subarray(500_000, 500_100)))
    await writeFile(join(root, 'file.bin'), Buffer.alloc(bytes.length, 0))
    const all: Uint8Array[] = []
    for await (const chunk of file.stream()) all.push(chunk)
    expect(digest(Buffer.concat(all))).toBe(revision.sha256)
    expect('path' in file).toBe(false); expect('write' in file).toBe(false); expect(never).not.toHaveBeenCalled()
    await file.dispose()
    expect(await readdir(tempRoot)).toEqual([])
  })
  it('requires cloud ACL for an agent rather than borrowing the person’s local permission', async () => {
    const provider = localProjectFileProvider({ identity, read: reader(), tempRoot, env })
    expect(await provider({ ref, actor: { ...actor, actorId: 'agent' } })).toBeNull()
    accountId = 'other'
    expect(await provider({ ref, actor })).toBeNull()
  })
  it.each([[-1, 1], [0.5, 1], [0, 524_289], [700_001, 1]])('rejects rather than clamps invalid range %j/%j', async (offset, length) => {
    await expect(reader()({ ref, offset, length }, 'owner')).rejects.toThrow('Invalid file range')
  })
  it('rejects a caller-selected path, another identity and a symlink escaping the bound root', async () => {
    await expect(reader()({ ref, offset: 0, length: 0, path: '../secret' } as never, 'owner')).rejects.toThrow('Invalid file read request')
    await expect(reader()({ ref, offset: 0, length: 1 }, 'other')).rejects.toThrow('device owner')
    await writeFile(join(home, 'outside'), bytes)
    await rm(join(root, 'file.bin')); await symlink(join(home, 'outside'), join(root, 'file.bin'))
    await expect(reader()({ ref, offset: 0, length: 1 }, 'owner')).rejects.toThrow('outside this workspace')
  })
  it('rejects same-size SHA changes before exposing a snapshot and removes staging', async () => {
    await writeFile(join(root, 'file.bin'), Buffer.alloc(bytes.length, 9))
    await expect(snapshotProjectFile(revision, request => reader()(request, 'owner'), tempRoot)).rejects.toThrow('SHA-256 mismatch')
    expect(await readdir(tempRoot)).toEqual([])
  })
  it('anchors current metadata, then detects modification, unbinding and account changes', async () => {
    // A part asked once the file has changed is refused (parts asked before are of the anchored version, and run ahead).
    const source = await openProjectFileSource(revision, request => reader()(request, 'owner'))
    await writeFile(join(root, 'file.bin'), Buffer.alloc(bytes.length, 9))
    await expect(source.read(0, 1)).rejects.toThrow('changed during read')
    await forgetProjectGroupId('project', 'owner', env)
    await expect(reader()({ ref, offset: 0, length: 0 }, 'owner')).rejects.toThrow('unavailable')
    accountId = 'other'
    await expect(reader()({ ref, offset: 0, length: 0 }, 'owner')).rejects.toThrow('device owner')
  })
  it('creates private bounded staging, does not publish partial data, and cleans cancellation', async () => {
    const sink = await createFileSink(tempRoot, 2)
    await sink.write(new Uint8Array([1]))
    await expect(sink.commit()).rejects.toThrow('Incomplete')
    await expect(sink.blob()).rejects.toThrow('not committed')
    await expect(sink.write(new Uint8Array([1, 2]))).rejects.toThrow('Invalid')
    const [dir] = await readdir(tempRoot)
    expect((await stat(join(tempRoot, dir!))).mode & 0o777).toBe(0o700)
    await sink.abort(); expect(await readdir(tempRoot)).toEqual([])
    const signal = AbortSignal.abort(new Error('cancelled'))
    await expect(snapshotProjectFile(revision, request => reader()(request, 'owner'), tempRoot, signal)).rejects.toThrow('cancelled')
    expect(await readdir(tempRoot)).toEqual([])
  })
})

describe('the owner’s already-held SSH link', () => {
  it('uses the real requester envelope and host read core, without opening or closing the window connection', async () => {
    let tap: { onMessage(message: unknown): void; onClosed(reason: string): void } | undefined
    const untap = vi.fn(), open = vi.fn(), close = vi.fn(), asked: number[] = [], spans: [number, number][] = []
    let pending = 0, most = 0
    const links = { ownedOpen: vi.fn(async () => true), open, close, tap: vi.fn((_device: string, handlers: typeof tap) => { tap = handlers; return untap }), send: vi.fn((_device: string, message: unknown) => {
      const envelope = (message as { payload: { request_id: string; user_id: string; payload: Parameters<ReturnType<typeof createProjectFileReader>>[0] } }).payload
      asked.push(envelope.payload.length); spans.push([envelope.payload.offset, envelope.payload.offset + envelope.payload.length]); most = Math.max(most, ++pending)
      void reader()(envelope.payload, envelope.user_id).then(result => { pending--; tap!.onMessage({ payload: { type: 'file.read:reply', request_id: envelope.request_id, result } }) })
      return true
    }) }
    const file = await ownSshFileProvider(links, tempRoot)(revision, { ref, actor })
    expect(file).not.toBeNull()
    expect(await file!.read(0, 4)).toEqual(new Uint8Array([83, 83, 83, 83]))
    // One metadata anchor, then the source from the smallest part, growing while each is quick; once the line has shown
    // it is quick, the next part is already asked for while one is on it.
    expect(asked.slice(0, 3)).toEqual([0, 64 * 1024, 128 * 1024])
    expect(most).toBe(2)
    // The parts run ahead of the 512 KB reads that verify the file: one is asked across the first read's end.
    expect(spans.some(([from, to]) => from < 524_288 && to > 524_288)).toBe(true)
    expect(open).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(untap).toHaveBeenCalledTimes(1)
    await file!.dispose()
  })
  it('reads a few-MB HTML over a slow link in parts that stay short, saying how far it has come', async () => {
    // The design page that would not open: 14 inline screenshots, about 4 MB.
    const html = Buffer.from(`<!doctype html><html><body>${`<img src="data:image/png;base64,${'A'.repeat(290_000)}">`.repeat(14)}</body></html>`)
    await writeFile(join(root, 'design.html'), html)
    const page: FileRevision = { ...revision, item_id: 'design', file_name: 'design.html', content_type: 'text/html', size_bytes: html.length, sha256: digest(html), relative_path: 'design.html' }
    await rememberProjectFile(page, 'owner', env)
    // A line that carries one reply at a time, each taking two seconds whatever it holds: a part must shrink to the
    // smallest, not hold the line. Replies leave in the order asked, each two seconds after the line is free.
    let now = 0, lineFree = 0, line = Promise.resolve()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const asked: number[] = []
    let open = 0, most = 0
    let tap: { onMessage(message: unknown): void; onClosed(reason: string): void } | undefined
    const links = { ownedOpen: vi.fn(async () => true), tap: vi.fn((_device: string, handlers: typeof tap) => { tap = handlers; return vi.fn() }), send: vi.fn((_device: string, message: unknown) => {
      const envelope = (message as { payload: { request_id: string; user_id: string; payload: Parameters<ReturnType<typeof createProjectFileReader>>[0] } }).payload
      asked.push(envelope.payload.length); most = Math.max(most, ++open)
      const arrives = lineFree = Math.max(lineFree, now) + 2_000, reply = reader()(envelope.payload, envelope.user_id)
      line = line.then(async () => {
        const result = await reply
        await new Promise(resolve => setTimeout(resolve, 0)) // the reader takes in the reply before it, as a line would
        now = arrives; open--
        tap!.onMessage({ payload: { type: 'file.read:reply', request_id: envelope.request_id, result } })
      })
      return true
    }) }
    const seen: [number, number][] = []
    try {
      const file = await ownSshFileProvider(links, tempRoot)(page, { ref: { item_id: 'design', version: 1 }, actor, progress: (done, total) => seen.push([done, total]) })
      const parts: Uint8Array[] = []
      for (let at = 0; at < html.length; at += 524_288) parts.push(await file!.read(at, Math.min(524_288, html.length - at)))
      expect(digest(Buffer.concat(parts))).toBe(page.sha256)
      await file!.dispose()
    } finally { clock.mockRestore() }
    expect(Math.max(...asked)).toBe(64 * 1024)
    // Two of these parts would hold the line past its budget: whatever else it carries must get through, so one at a time.
    expect(most).toBe(1)
    expect(seen.at(-1)).toEqual([html.length, html.length])
    expect(seen.every(([done], index) => index === 0 || done > seen[index - 1]![0])).toBe(true)
  })
  it.each(['absent', 'other-account', 'agent'])('does not attach when %s', async kind => {
    const links = { ownedOpen: vi.fn(async () => kind !== 'absent'), tap: vi.fn(), send: vi.fn() }
    const who = kind === 'other-account' ? { accountId: 'other', actorId: 'other' } : kind === 'agent' ? { ...actor, actorId: 'agent' } : actor
    expect(await ownSshFileProvider(links, tempRoot)(revision, { ref, actor: who })).toBeNull()
    expect(links.tap).not.toHaveBeenCalled(); expect(links.send).not.toHaveBeenCalled()
  })
})

describe('the host’s on-demand client-encrypted transfer', () => {
  function fixture(options: { denied?: boolean; changed?: boolean; late?: boolean; bothFail?: boolean } = {}) {
    const calls: string[] = [], commitBodies: Record<string, unknown>[] = []
    let uploaded: Uint8Array | undefined
    const read = vi.fn(async (request: Parameters<ReturnType<typeof createProjectFileReader>>[0]) => reader()(request, 'owner'))
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = String(input).split('/').at(-1)!
      calls.push(route)
      const body = route === 'object' ? null : JSON.parse(init!.body as string)
      if (route === 'file-pending') {
        const first = { ...revision, id: 'transfer', state: 'requested', ...(options.changed ? { sha256: '0'.repeat(64) } : {}) }
        // late: another reader's request lands while the first upload runs; the list read before it does not hold it.
        const pending = calls.filter(call => call === 'file-pending').length
        return Response.json({ transfers: options.late && pending > 1 ? [{ ...first, state: 'uploading' }, { ...revision, id: 'late', state: 'requested' }] : [first] })
      }
      if (route === 'file-accept') {
        if (options.denied || options.bothFail && body.transfer_id === 'late') return Response.json({ error: 'quota', message: 'Quota exhausted' }, { status: 403 })
        expect(body.ciphertext_bytes).toBe(ciphertextSize(bytes.length))
        if (body.transfer_id === 'transfer') expect(read).not.toHaveBeenCalled()
        return Response.json({ url: 'https://objects.invalid/object', fields: { key: 'random-object' }, max_bytes: ciphertextSize(bytes.length) })
      }
      if (route === 'object') {
        if (options.late && !late) late = drain()
        const form = init!.body as FormData
        expect([...form.keys()]).toEqual(['key', 'file'])
        uploaded = new Uint8Array(await (form.get('file') as Blob).arrayBuffer())
        expect(Buffer.from(uploaded)).not.toEqual(bytes)
        expect(uploaded.length).toBe(ciphertextSize(bytes.length))
        return new Response(null, { status: 204 })
      }
      if (route === 'file-commit') {
        expect(body.ciphertext_sha256).toBe(digest(uploaded!))
        expect(Buffer.from(body.key, 'base64').length).toBe(32)
        if (options.bothFail) return Response.json({ error: 'unavailable', message: 'Storage is down' }, { status: 503 })
        commitBodies.push(body)
        return Response.json({ status: 'ready' })
      }
      throw Error(`Unexpected fake route ${route}`)
    })
    let late: Promise<void> | undefined
    const drain = createProjectTransferHost({ identity, read, tempRoot, env, endpoint: async () => ({ supabaseUrl: 'https://api.invalid', anonKey: 'test-anon', token: 'test-token', fetch: fetcher as typeof fetch }) })
    return { drain, calls, read, commitBodies, uploaded: () => uploaded, late: () => late }
  }
  it('reserves before disk/bytes, uses one upload executor, transfers the key only in commit and removes staging', async () => {
    const f = fixture()
    await Promise.all([f.drain(), f.drain()])
    // The second event reads the list once more after the first drain; the transfer already taken is not taken again.
    expect(f.calls).toEqual(['file-pending', 'file-accept', 'object', 'file-commit', 'file-pending'])
    expect(await readdir(tempRoot)).toEqual([])
    const cipher = f.uploaded()!
    const source = { size: cipher.length, dispose: async () => {}, read: async (offset: number, length: number) => cipher.slice(offset, offset + length) }
    const key = Buffer.from(f.commitBodies[0]!.key as string, 'base64')
    const decoded = await transformFile({ direction: 'decrypt', revision, source, key, ciphertextSha256: digest(cipher), sink: await createFileSink(tempRoot, bytes.length) })
    expect(digest(new Uint8Array(await (async () => {
      const chunks = []
      for (let offset = 0; offset < bytes.length; offset += 524288) chunks.push(await decoded.file.read(offset, Math.min(524288, bytes.length - offset)))
      return Buffer.concat(chunks)
    })()))).toBe(revision.sha256)
    await decoded.file.dispose(); key.fill(0)
    await f.drain() // A repeated event does not generate another key or overwrite an accepted object.
    expect(f.calls.filter(value => value === 'object')).toHaveLength(1)
  })
  it('serves a request that lands while a drain is uploading, from a second read of the list', async () => {
    const f = fixture({ late: true })
    await f.drain()
    await f.late()
    expect(f.commitBodies.map(body => body.transfer_id)).toEqual(['transfer', 'late'])
    expect(f.calls.filter(call => call === 'file-pending')).toHaveLength(2)
  })
  it('reports the failures of every round, not only the last', async () => {
    const f = fixture({ late: true, bothFail: true })
    const both = '2 project file transfer(s) failed; no unverified bytes were committed (transfer: file-commit 503 unavailable; late: file-accept 403 quota)'
    await expect(f.drain()).rejects.toThrow(both)
    await expect(f.late()).rejects.toThrow(both) // the event during the round joined it and hears the same outcome
  })
  it('names a failed transfer by id and a fixed reason, never a local path', async () => {
    const f = fixture()
    await rm(join(root, 'file.bin'))
    const failure = await f.drain().then(() => null, (error: Error) => error.message)
    expect(failure).toMatch(/^1 project file transfer\(s\) failed; .*\(transfer: \w+\)$/)
    expect(failure).not.toContain(root)
  })
  it.each(['quota', 'revision', 'source-sha'])('does not upload or commit when %s fails', async failure => {
    const f = fixture({ denied: failure === 'quota', changed: failure === 'revision' })
    if (failure === 'source-sha') await writeFile(join(root, 'file.bin'), Buffer.alloc(bytes.length, 9))
    await expect(f.drain()).rejects.toThrow(failure === 'quota' ? '(transfer: file-accept 403 quota)' : failure === 'revision' ? '(transfer: Transfer revision changed)' : '(transfer: File SHA-256 mismatch)')
    expect(f.calls).not.toContain('object'); expect(f.calls).not.toContain('file-commit')
    if (failure !== 'source-sha') expect(f.read).not.toHaveBeenCalled()
    expect(await readdir(tempRoot).catch(() => [])).toEqual([])
  })
})
