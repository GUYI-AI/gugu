import type { RuntimeAuth } from '@gugu/core'
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { readCachedDeviceId } from '@gugu/core/cloud/deviceRuntime'
import { accountAttachmentsEndpoint, attachmentRequest, offerImagePreviewOf } from '@gugu/core/cloud/attachmentsApi'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { createFileMetadataLoader } from '@gugu/core/cloud/fileMetadata'
import { cloudFileProviders } from '@gugu/core/cloud/fileProviders'
import { createFileCache, createFileChunkCache, createFileSink, createFileSaver, fileCacheDirectory, localCopy, storeFileBytes, writeFileHandle } from '@gugu/core/local/files/fileSnapshots'
import { DEVICE_STORE, FILE_CHUNK_BYTES, createFileResolver, type FileActor, type FileBytes, type FileContext, type FileMetadata, type FilePreview, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver'
import { coreLogger } from '@gugu/core/log'
import { parseFileStorage } from '@gugu/core/shared/fileStorage'
import { readUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { PROJECT_FILE_READ, createProjectFileReader, createProjectFileStreamer, heldFileBlob, localProjectFileProvider } from './projectFileHost'
import { ownSshFileProvider, type HeldFileSshLinks } from './projectFileSsh'
import { createProjectTransferHost } from './projectFileTransferHost'
import { findProjectFileByName, heldRevisionBySha, type ProjectFileVersionLookup } from './sessionpage/sessionpage-project-groups'
import type { setAccountFileResolver } from './session/main/core/extensions/account-token'
import { createProjectFilePublisher } from './projectFilePublication'
import type { makeIdentityClient } from './supabase'

/** One composition root for native IPC, Apps, MCP and inbox. Identity lookup here never registers or refreshes. */
type RpcReply = { data: unknown; error: { message: string; code: string; details: string; hint: string } | null }

/**
 * The database RPC the desktop file paths call, as the signed-in reader. A refusal becomes an Error carrying the
 * database message and its structured diagnostics (code / details / hint), with the original as its cause, so the
 * App sees the real reason a file was not changed; a network rejection passes through as it is.
 */
export function signedInFileRpc(
  auth: () => Promise<{ accessToken: string } | null>,
  client: (accessToken: string) => { rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcReply> },
): (name: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (name, args) => {
    const session = await auth()
    if (!session) throw new Error('File reader is not signed in')
    const { data, error } = await client(session.accessToken).rpc(name, args)
    if (error) throw Object.assign(new Error(error.message, { cause: error }), { code: error.code, details: error.details, hint: error.hint })
    return data
  }
}

export function createDesktopFileAccess(deps: {
  auth(): Promise<RuntimeAuth | null>; root(projectId: string): Promise<string | null>
  /** This device's project bound to a chat, as the account records it. */
  project(chatId: string): Promise<string | undefined>
  links(): HeldFileSshLinks | null; tempRoot: string; fetch: typeof globalThis.fetch; env?: NodeJS.ProcessEnv
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>
  /** Where this device keeps what it sends into project chats it binds no project to (DEVICE_STORE). */
  deviceStore: string
  /** This device's Gugu home: its file cache (`fileCacheDirectory`) keeps what the window read over the network, up to `cacheBytes`. */
  home: string; cacheBytes?: number
  /** The identity schema, as the signed-in account: its own settings and projects. */
  identityDb(accessToken: string): ReturnType<typeof makeIdentityClient>
}) {
  // The device store is served and written like a project root.
  const root = async (projectId: string) => {
    if (projectId !== DEVICE_STORE) return deps.root(projectId)
    await mkdir(deps.deviceStore, { recursive: true, mode: 0o700 })
    return deps.deviceStore
  }
  const identityDb = async () => {
    const auth = await deps.auth(); if (!auth) throw new Error('File publisher is not signed in')
    return { auth, db: deps.identityDb(auth.accessToken) }
  }
  const identity = async () => {
    const auth = await deps.auth(); if (!auth) throw new Error('File reader is not signed in')
    return { accountId: auth.userId, deviceId: await readCachedDeviceId(deps.env, auth.userId) }
  }
  const endpoint = async (context?: FileContext) => {
    const auth = await deps.auth()
    if (!auth || context && auth.userId !== context.actor.accountId) throw new Error('File reader account changed')
    return accountAttachmentsEndpoint({ supabaseUrl: getSupabaseUrl(), anonKey: getSupabaseAnonKey(), getAccessToken: async () => auth.accessToken }, deps.fetch)
  }
  const later: ProjectFileVersionLookup = async ref => {
    const row = await attachmentRequest(await endpoint(), 'file-resolve', { ref, as: (await identity()).accountId }) as FileRevision & { status?: string }
    return row?.status === 'ready' ? row : null
  }
  const read = createProjectFileReader({ identity, root, env: deps.env, later })
  /** The same held versions as `read`, as one stream on a device link (`file.stream`). */
  const stream = createProjectFileStreamer({ identity, root, env: deps.env, later })
  const metadata = createFileMetadataLoader(async (context, refs) => attachmentRequest(await endpoint(context), 'file-resolve', { refs, as: context.actor.actorId }, context.signal))
  const providers = { ...cloudFileProviders({ endpoint, metadata, cache: createFileChunkCache(deps.tempRoot), sink: size => createFileSink(deps.tempRoot, size) }),
    local: localProjectFileProvider({ identity, read, root, env: deps.env, later }),
    ssh: async (...args: Parameters<ReturnType<typeof ownSshFileProvider>>) => {
      const links = deps.links(); return links ? ownSshFileProvider(links, deps.tempRoot)(...args) : null
    },
  }
  const saveTo = createFileSaver(providers)
  const resolve = createFileResolver({ ...providers, saveTo })
  const cache = createFileCache(fileCacheDirectory(deps.home), deps.cacheBytes), log = coreLogger('file-cache')
  const blobBytes = (blob: Blob): FileBytes => ({ size: blob.size, here: true, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()), dispose: async () => {} })
  /**
   * This machine's bytes of `sha256`, without the network: the file store's copy or an original this machine sent, a
   * version it holds in a project, else what the window read before (the file cache).
   */
  const here = async (sha256: string): Promise<FileBytes | null> => {
    const kept = await localCopy(deps.home, sha256) ?? await held(sha256)
    return kept ? blobBytes(kept) : cache.read(sha256)
  }
  /**
   * A cloud file as this desktop's window reads it. What comes over the network is kept in this machine's file cache, so a
   * later open or download reads it here: a managed object is read straight into the cache, and a copy another device
   * relays, which may be shown before its read is acknowledged, is kept once it is. A historical object without a sha
   * has no place in the cache and is only read.
   */
  const cachedRead = async (revision: FileRevision, context: FileContext): Promise<FileBytes> => {
    if (revision.source !== 'managed-object') {
      const file = await providers.temporary(revision, context)
      // Keeping it only saves a later read: failing to never takes down what was read.
      const keep = () => cache.read(revision.sha256!, () => storeFileBytes(cache.directory, revision.sha256!, revision.file_name, revision.content_type, file))
        .then(kept => kept?.dispose(), (error: unknown) => log.warn({ error }, 'relayed copy not kept'))
      const acknowledged = (file.acknowledged ?? Promise.resolve()).then(keep)
      acknowledged.catch(() => undefined)
      return { ...file, here: true, acknowledged }
    }
    if (!revision.sha256) return providers.managed(revision, context)
    return (await cache.read(revision.sha256, () => saveTo(revision, context, cache.directory, revision.file_name, true)))!
  }
  /**
   * The window's cloud reads (`nativeFileHost` op `cloud`…). A preview is a video's signed address, which Chromium's media
   * loader reads itself, or an image's small copy as bytes; an image without one is shown from the file, read like any file.
   */
  const cloud = {
    read: cachedRead,
    async preview(revision: FileRevision, context: FileContext) {
      const shown = await providers.preview!(revision, context, async () => { throw new Error('File preview is the file itself') })
      return shown instanceof Blob ? new Uint8Array(await shown.arrayBuffer()) : shown
    },
    expiredPreview: async (preview: FilePreview, context: FileContext) => new Uint8Array(await (await providers.expiredPreview!(preview, context)).arrayBuffer()),
  }
  /** `bytes` written beside `target` under a private name, then into place: a save that fails leaves nothing there. */
  const save = async (bytes: FileBytes, target: string) => {
    const partial = `${target}.${randomUUID()}.part`
    try {
      const output = await open(partial, 'wx', 0o644)
      try { for (let offset = 0; offset < bytes.size; offset += FILE_CHUNK_BYTES) await output.writeFile(await bytes.read(offset, Math.min(FILE_CHUNK_BYTES, bytes.size - offset))) }
      finally { await output.close() }
      await rename(partial, target)
    } catch (error) { await rm(partial, { force: true }); throw error }
  }
  /**
   * A file saved where the person says (`pick`: the save dialog; `null` saves nothing). The bytes are this machine's.
   * `known`: its bytes of the version the window already knows, saved without asking the server (local-first, as an
   * open is). Otherwise the server says which version it is: a file this machine keeps itself is written from where it
   * is, anything else from this machine's copy of it, read into the file cache first when it has none. `revision`: the
   * version saved, for the window to know next time.
   */
  const download = async (ref: FileRef, actor: FileActor, pick: () => Promise<string | null>, known: FileBytes | null, signal?: AbortSignal): Promise<{ saved: boolean; revision?: FileRevision } | { status: Exclude<FileMetadata['status'], 'ready'> }> => {
    if (known) {
      try { const target = await pick(); if (target) await save(known, target); return { saved: !!target } }
      finally { await known.dispose() }
    }
    const file = await resolve(ref, actor, signal ? { signal } : {})
    if (file.status !== 'ready') return { status: file.status }
    try {
      const target = await pick()
      if (!target) return { saved: false }
      const context: FileContext = { ref, actor, ...(signal ? { signal } : {}) }, { revision } = file
      if (!revision.sha256 || await providers.local(context)) await writeFileHandle(file, target)
      else {
        const copy = await here(revision.sha256) ?? (await cache.read(revision.sha256, () => saveTo(revision, context, cache.directory, revision.file_name, true)))!
        try { await save(copy, target) } finally { await copy.dispose() }
      }
      return { saved: true, revision }
    } finally { await file.dispose() }
  }
  const drain = createProjectTransferHost({ identity, endpoint, read: async request => read(request, (await identity()).accountId), tempRoot: deps.tempRoot, env: deps.env, later })
  const resolveAccount: Parameters<typeof setAccountFileResolver>[0] = async (ref, actor, options) => {
    const { accountId, deviceId } = await identity()
    if ('name' in ref) {
      const local = await findProjectFileByName(ref.chat, ref.name, accountId, deviceId, deps.env)
      if (!local) { if (options?.localOnly) return null; throw new Error('File must first be resolved to its item id') }
      ref = { item_id: local.item_id! }
    }
    const fileRef: FileRef = 'id' in ref ? { item_id: ref.id, ...(options?.version ? { version: options.version } : {}) } : ref
    const reader = { accountId, actorId: actor ?? accountId }
    return resolve(fileRef, reader, { ...(options?.localOnly ? { localOnly: true } : {}), ...(options?.signal ? { signal: options.signal } : {}) })
  }
  const sshHandlers: DeviceRpcHandlers = { [PROJECT_FILE_READ]: async (payload, ctx) => ({ result: await read(payload as Parameters<typeof read>[0], ctx.request.user_id) }) }
  const publish = createProjectFilePublisher({ identity, root, project: deps.project, rpc: deps.rpc, env: deps.env,
    preview: async (original, contentType, sha256) => offerImagePreviewOf(await endpoint(), original, contentType, sha256, (await identity()).accountId),
    async storage() { const { auth, db } = await identityDb(); return parseFileStorage(await readUserSettingsConfig(db as unknown as SettingsTableClient, auth.userId, 'user')) },
    // The account's projects are its project groups (chat.project_groups), with or without a folder on any machine.
    async projectChat(chatId) {
      const { db } = await identityDb()
      const { data, error } = await db.rpc('is_my_project', { p_chat_id: chatId })
      if (error) throw new Error(`is_my_project: ${error.message}`)
      if (typeof data !== 'boolean') throw new Error('is_my_project: unexpected answer')
      return data
    },
  })
  /** The bytes of a version this device holds in a project, found by its sha: read where they are, checked against it. */
  const held = async (sha256: string): Promise<Blob | null> => {
    const { accountId, deviceId } = await identity()
    const revision = await heldRevisionBySha(sha256, accountId, deviceId, deps.env)
    const projectRoot = revision ? await root(revision.host_project_id!) : null
    return revision && projectRoot ? heldFileBlob(revision, projectRoot).catch(() => null) : null
  }
  return { providers, resolve, resolveAccount, read, stream, drain, publish, held, here, cloud, download, cacheIdle: cache.idle,
    handlers: (transport: 'ssh' | 'realtime'): DeviceRpcHandlers => transport === 'ssh' ? sshHandlers : {},
  }
}
