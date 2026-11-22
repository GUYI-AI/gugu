import type { RuntimeAuth } from '@gugu/core'
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder'
import { mkdir } from 'node:fs/promises'
import { readCachedDeviceId } from '@gugu/core/cloud/deviceRuntime'
import { attachmentRequest, configuredEndpoint, offerImagePreviewOf } from '@gugu/core/cloud/attachmentsApi'
import { createFileMetadataLoader } from '@gugu/core/cloud/fileMetadata'
import { cloudFileProviders } from '@gugu/core/cloud/fileProviders'
import { createFileChunkCache, createFileSink, createFileSaver } from '@gugu/core/local/files/fileSnapshots'
import { cloudObjectFetch } from './session/main/core/files/cloud-object-fetch'
import { DEVICE_STORE, createFileResolver, type FileContext, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver'
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
    return { ...configuredEndpoint(auth.accessToken), fetch: deps.fetch }
  }
  const later: ProjectFileVersionLookup = async ref => {
    const row = await attachmentRequest(await endpoint(), 'file-resolve', { ref, as: (await identity()).accountId }) as FileRevision & { status?: string }
    return row?.status === 'ready' ? row : null
  }
  const read = createProjectFileReader({ identity, root, env: deps.env, later })
  /** The same held versions as `read`, as one stream on a device link (`file.stream`). */
  const stream = createProjectFileStreamer({ identity, root, env: deps.env, later })
  const metadata = createFileMetadataLoader(async (context, refs) => attachmentRequest(await endpoint(context), 'file-resolve', { refs, as: context.actor.actorId }, context.signal))
  const providers = { ...cloudFileProviders({ endpoint, metadata, fetch: cloudObjectFetch, cache: createFileChunkCache(deps.tempRoot), sink: size => createFileSink(deps.tempRoot, size) }),
    local: localProjectFileProvider({ identity, read, root, env: deps.env, later }),
    ssh: async (...args: Parameters<ReturnType<typeof ownSshFileProvider>>) => {
      const links = deps.links(); return links ? ownSshFileProvider(links, deps.tempRoot)(...args) : null
    },
  }
  const resolve = createFileResolver({ ...providers, saveTo: createFileSaver(providers) })
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
  return { providers, resolve, resolveAccount, read, stream, drain, publish, held,
    handlers: (transport: 'ssh' | 'realtime'): DeviceRpcHandlers => transport === 'ssh' ? sshHandlers : {},
  }
}
