// @@@sessionpage TASKPAGE-FUSION — 「这个项目对应哪个群」的持久映射(spec ⑨:项目 = 群)。
//
// 为什么单独存一份:映射原本只写在每条 agent roster 记录的 cache 上(project→group),于是项目里最后一个
// agent 被摘掉时映射也跟着消失 —— 同一个项目下一次开会话就又建一个新群,owner 眼里同名群越攒越多
// (实机上确实攒出了两个同名的 `new project` 群)。群的寿命属于**项目**,不属于某个 agent 实例,所以它
// 得存在与 agent 生命周期无关的地方。
//
// 只在本机存:群本身在云端,这份文件是这台机器上「项目 id → 群 id」的唯一来源。读不动(坏 JSON / 权限)就抛:
// 当成空会把项目合到别的群或重复建群。写入路径原子落盘,避免半截 JSON。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listAgents } from '@gugu/core'
import { agentOwnerUserId } from '@gugu/core/local/state/agentOwner'
import { atomicWriteText, resolveGuguHome } from '@gugu/core/local/state/paths'
import { DEVICE_STORE, fileRefKey, requireFileRevision, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver'
import { createLogger } from '../lib/logger'
import { SESSIONPAGE_GROUP_CHAT_CACHE_KEY, SESSIONPAGE_PROJECT_CACHE_KEY } from '../session/main/core/sessionpage/sessionpage-session-agent'

const FILE_NAME = 'taskpage-project-groups.json'

function filePath(env: NodeJS.ProcessEnv): string {
  return join(resolveGuguHome(env), FILE_NAME)
}

// #4277 —— 群归**账号**:A 建的群 B 进不去(RLS),所以「项目 → 群」得按账号分区,B 在同一项目有自己的
// 群。文件形状 v2:`{ owners: { <uid>: { <projectId>: <chatId> } }, unowned: { <projectId>: <chatId> } }`;
// `unowned` 装 v1 平铺时代不知道归谁的条目,由第一个能看见那个群的账号认领(见 readProjectGroupId
// 的两段读法与 rememberProjectGroupId 的顺手清理)。
type ProjectMap = Record<string, string>
interface Mapping {
  owners: Record<string, ProjectMap>
  unowned: ProjectMap
  /**
   * This device's own file versions, by item: a cache of the database's version records (immutable per version), filled
   * when this device publishes a version or the database answers for one, at most FILE_CACHE_MAX items per account.
   * Whether this device still holds a version is decided at read time from the binding, never by dropping entries.
   */
  files?: Record<string, Record<string, FileRevision>>
  /** The roster's project groups were copied in (migrateRosterGroups); the roster is never read for them again. */
  rosterMigrated?: true
}

function readProjectMap(source: unknown): ProjectMap {
  const out: ProjectMap = {}
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out
  for (const [projectId, chatId] of Object.entries(source as Record<string, unknown>)) {
    if (projectId && typeof chatId === 'string' && chatId) out[projectId] = chatId
  }
  return out
}

function parseMapping(parsed: unknown): Mapping {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('project group mapping is not an object')
  const raw = parsed as Record<string, unknown>
  if (raw.owners && typeof raw.owners === 'object' && !Array.isArray(raw.owners)) {
    const owners: Record<string, ProjectMap> = {}
    for (const [ownerId, map] of Object.entries(raw.owners as Record<string, unknown>)) {
      if (ownerId) owners[ownerId] = readProjectMap(map)
    }
    // 从前另记过 `representatives`(同群几个本地项目里谁画那一行);改由读方按 groupRowOrder 算,旧文件里的这个键读时不认、下次写时去掉。
    return { owners, unowned: readProjectMap(raw.unowned), files: raw.files as Mapping['files'], ...(raw.rosterMigrated === true ? { rosterMigrated: true } : {}) }
  }
  // v1:整份文件就是一张 { projectId: chatId },归属未知。
  return { owners: {}, unowned: readProjectMap(raw) }
}

/** The file as it is. Only a first run (no file) reads as empty; any other failure throws (❌ an empty mapping). */
async function loadMapping(env: NodeJS.ProcessEnv): Promise<Mapping> {
  let text: string
  try {
    text = await readFile(filePath(env), 'utf8')
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return { owners: {}, unowned: {} }
    throw new Error(`project group mapping ${filePath(env)} is unreadable`, { cause: error })
  }
  try {
    return parseMapping(JSON.parse(text) as unknown)
  } catch (error) {
    throw new Error(`project group mapping ${filePath(env)} is unreadable`, { cause: error })
  }
}

async function writeMapping(mapping: Mapping, env: NodeJS.ProcessEnv): Promise<void> {
  const owners: Record<string, ProjectMap> = {}
  for (const [ownerId, map] of Object.entries(mapping.owners)) {
    if (Object.keys(map).length) owners[ownerId] = map
  }
  const { unowned, files, rosterMigrated } = mapping
  await atomicWriteText(filePath(env), `${JSON.stringify({ owners, unowned, files, rosterMigrated }, null, 2)}\n`)
}

// 同一个 main 进程里可能有多个会话同时 provision(实机:一个项目里连开两个任务)。read-modify-write
// 不串行化 = 后写覆盖先写、丢掉另一个项目的条目 → 那个项目下次又建新群。用一条 promise 链把所有
// 变更排队(❌ 各自读改写)。
//
// #7341 这条队列是这份文件**唯一**的写口:写者(供给、回收器、项目群绑定)全在宿主这一侧、import 的都是本模块;
// 会话页那一侧只读(app-given.ts)。❌ 在会话页树里另 import 本模块来写 —— 要写就经宿主注入的 ProjectGroupHost。
let writeQueue: Promise<void> = Promise.resolve()
function enqueue(mutate: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(mutate, mutate)
  writeQueue = next.catch(() => {})
  return next
}

/**
 * @@@roster-migration - older versions kept a project's group only on its agents' roster rows (the cache pins
 * provisioning writes). They are copied into this mapping once per file — an entry already here wins, an agent with no
 * recorded owner goes to `unowned` — and the file says so; from then on the roster is never read for a project's group.
 */
async function migrateRosterGroups(mapping: Mapping, env: NodeJS.ProcessEnv): Promise<void> {
  for (const agent of await listAgents(env, { includeGuests: true })) {
    if (agent.status === 'archived') continue
    const projectId = agent.cache?.[SESSIONPAGE_PROJECT_CACHE_KEY]
    const chatId = agent.cache?.[SESSIONPAGE_GROUP_CHAT_CACHE_KEY]
    if (typeof projectId !== 'string' || !projectId || typeof chatId !== 'string' || !chatId) continue
    const owner = agentOwnerUserId(agent)
    const map = owner ? (mapping.owners[owner] ??= {}) : mapping.unowned
    map[projectId] ??= chatId
  }
  mapping.rosterMigrated = true
}

const migrated = new Map<string, Promise<void>>()
/** Every reader and writer waits for the one-shot roster migration of its file (it runs first in the write queue). */
function migratedMapping(env: NodeJS.ProcessEnv): Promise<void> {
  const path = filePath(env)
  let done = migrated.get(path)
  if (!done) {
    done = enqueue(async () => {
      const mapping = await loadMapping(env)
      if (mapping.rosterMigrated) return
      await migrateRosterGroups(mapping, env)
      await writeMapping(mapping, env)
    })
    // A failed migration (unreadable file or roster) is tried again by the next caller, never skipped.
    done.catch(() => migrated.delete(path))
    migrated.set(path, done)
  }
  return done
}

async function readMapping(env: NodeJS.ProcessEnv): Promise<Mapping> {
  await migratedMapping(env)
  return loadMapping(env)
}

/** The sole write path: read, change and write the file in the queue, after its migration. */
async function mutateMapping(env: NodeJS.ProcessEnv, mutate: (mapping: Mapping) => Promise<void>): Promise<void> {
  await migratedMapping(env)
  await enqueue(async () => mutate(await loadMapping(env)))
}

// #7341 第二步:绑定(项目 → 群)是跨设备的项目身份,渲染层按它把各台机器的项目合成一行 —— 变了得让它重读。
// 谁写的都算(新会话建了群、回收器忘了一条、用户并进来 / 撤销),所以挂在唯一的写口上,❌ 每个写者各自去发。
type MappingChangeListener = (change: { projectId: string; ownerUserId: string }) => void
const changeListeners = new Set<MappingChangeListener>()
const log = createLogger('sessionpage/project-groups')

/** 「项目 → 群」对照真的改了(写进了文件)就叫一声。返回退订。 */
export function onProjectGroupMappingChanged(listener: MappingChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function announceChange(projectId: string, ownerUserId: string): void {
  for (const listener of changeListeners) {
    // 听的人出错不能把这次写入变成失败:文件已经落盘了。
    try {
      listener({ projectId, ownerUserId })
    } catch (error) {
      log.error({ projectId, err: error }, '#7341 a listener of project→group mapping changes threw — the write itself landed')
    }
  }
}

/**
 * 这个会话页项目在**这个账号**名下已经有对应的 gugu 群吗?返回 chatId,没有则 null。
 *
 * 账号自己的条目优先;没有时退回 v1 时代不知道归谁的条目 —— 调用方拿它去云端问一句「还在吗」,
 * 看得见就用 rememberProjectGroupId 认领到自己名下,看不见(别家的群,RLS 挡着)就当没有、自己建。
 */
export async function readProjectGroupId(
  projectId: string,
  ownerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const id = projectId.trim()
  if (!id) return null
  const mapping = await readMapping(env)
  return mapping.owners[ownerUserId]?.[id] ?? mapping.unowned[id] ?? null
}

/** 记住「这个账号名下,项目 → 群」。同一项目重复写入同一个群是幂等的;认领走的是 v1 条目就顺手清掉它。 */
export async function rememberProjectGroupId(
  projectId: string,
  chatId: string,
  ownerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const id = projectId.trim()
  const chat = chatId.trim()
  if (!id || !chat || !ownerUserId) return
  await mutateMapping(env, async (mapping) => {
    const mine = mapping.owners[ownerUserId] ?? {}
    const adopted = mapping.unowned[id] === chat
    if (mine[id] === chat && !adopted) return
    mine[id] = chat
    mapping.owners[ownerUserId] = mine
    if (adopted) delete mapping.unowned[id]
    await writeMapping(mapping, env)
    announceChange(id, ownerUserId)
  })
}

/** 项目没了(群已归档)→ 这个账号忘掉它,别让下一次查询复用一个归档群。归档的若是 v1 条目也一并忘。 */
export async function forgetProjectGroupId(
  projectId: string,
  ownerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const id = projectId.trim()
  if (!id) return
  await mutateMapping(env, async (mapping) => {
    const mine = mapping.owners[ownerUserId]
    const hadMine = Boolean(mine && id in mine)
    const hadUnowned = id in mapping.unowned
    if (!hadMine && !hadUnowned) return
    // This device's file versions under the project stay cached: they are unreadable while it is unbound (keptFor) and
    // readable again once it is bound to the same chat (project_restore_device keeps files).
    if (mine) delete mine[id]
    delete mapping.unowned[id]
    await writeMapping(mapping, env)
    announceChange(id, ownerUserId)
  })
}

/** A revision this device keeps for its chat: under a project still bound to that chat, or in its device store (no binding). */
function keptFor(mapping: Mapping, ownerId: string, revision: FileRevision): boolean {
  return revision.host_project_id === DEVICE_STORE || mapping.owners[ownerId]?.[revision.host_project_id!] === revision.chat_id
}

/** The fields of a version record this device keeps and answers with (roots are resolved from the project registry at read time). */
function revisionRecord(revision: FileRevision): FileRevision {
  const { source, item_id, version, chat_id, file_name, content_type, size_bytes, sha256, host_device_id, host_project_id, host_account_id, relative_path, workspace } = revision
  return { source, item_id, version, chat_id, file_name, content_type, size_bytes, sha256, host_device_id, host_project_id, host_account_id, relative_path, ...(workspace ? { workspace } : {}) }
}

/** This device's version record, while this device holds it for its chat; null otherwise. */
function held(mapping: Mapping, ownerId: string, deviceId: string, revision: FileRevision): FileRevision | null {
  requireFileRevision(revision)
  return revision.source === 'local' && !!revision.chat_id && revision.host_account_id === ownerId && revision.host_device_id === deviceId &&
    keptFor(mapping, ownerId, revision) ? revisionRecord(revision) : null
}

/** Items whose version records this device caches per account; past it the least recently written go (a miss asks the database). */
const FILE_CACHE_MAX = 2000

/** Put a version record into the account's cache, as its most recent entry, and drop the oldest past FILE_CACHE_MAX. */
function putRevision(mapping: Mapping, ownerId: string, revision: FileRevision): void {
  const mine = (mapping.files ??= {})[ownerId] ??= {}
  delete mine[revision.item_id!]
  mine[revision.item_id!] = revisionRecord(revision)
  const items = Object.keys(mine)
  for (const item of items.slice(0, Math.max(0, items.length - FILE_CACHE_MAX))) delete mine[item]
}

/** Keep a version record of this device's in the cache (the newest one per item). */
function cacheRevision(revision: FileRevision, ownerId: string, env: NodeJS.ProcessEnv): Promise<void> {
  return mutateMapping(env, async (mapping) => {
    const mine = mapping.files?.[ownerId]
    const cached = mine && Object.hasOwn(mine, revision.item_id!) ? mine[revision.item_id!] : undefined
    if (cached && cached.version! >= revision.version!) return
    putRevision(mapping, ownerId, revision)
    await writeMapping(mapping, env)
  })
}

/** A version this device just published: its record goes into the cache, under a binding still current. */
export async function rememberProjectFile(revision: FileRevision, ownerId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireFileRevision(revision)
  if (revision.source !== 'local' || revision.host_account_id !== ownerId || !revision.chat_id) throw new Error('File owner or group mismatch')
  await mutateMapping(env, async (mapping) => {
    if (!keptFor(mapping, ownerId, revision)) throw new Error('Project binding changed')
    putRevision(mapping, ownerId, revision)
    await writeMapping(mapping, env)
  })
}

export async function findProjectFileByName(chat: string, name: string, ownerId: string, deviceId: string, env: NodeJS.ProcessEnv = process.env) {
  const mapping = await readMapping(env)
  const found = Object.values(mapping.files?.[ownerId] ?? {}).find(row => row.chat_id === chat && row.workspace?.path === name)
  return found ? held(mapping, ownerId, deviceId, found) : null
}

export async function findProjectFileCopy(projectId: string, sha: string, ownerId: string, deviceId: string, env: NodeJS.ProcessEnv = process.env) {
  const mapping = await readMapping(env)
  const found = Object.values(mapping.files?.[ownerId] ?? {}).findLast(row => row.host_project_id === projectId && row.sha256 === sha && row.relative_path?.startsWith('.gugu/attachments/'))
  return found ? held(mapping, ownerId, deviceId, found) : null
}

/** The database's record of one version of a file (its current one when no version is named). */
export type ProjectFileVersionLookup = (ref: { item_id: string; version?: number }) => Promise<FileRevision | null>

/**
 * Does this device hold this version of a file: the database's version record says so (this account, this device, a
 * project of this device's that is still bound to the file's chat, or its device store). A named version the cache has is
 * answered from it (a version record never changes); anything else is asked of the database, and its answer is cached.
 */
export async function readProjectFile(ref: FileRef, ownerId: string, deviceId: string, env: NodeJS.ProcessEnv = process.env, lookup: ProjectFileVersionLookup): Promise<FileRevision | null> {
  fileRefKey(ref)
  if (!('item_id' in ref) || !ownerId || !deviceId) return null
  const mapping = await readMapping(env)
  const mine = mapping.files?.[ownerId]
  const cached = mine && Object.hasOwn(mine, ref.item_id) ? mine[ref.item_id] : undefined
  const answer = ref.version !== undefined && cached?.version === ref.version ? cached
    : await lookup(ref.version === undefined ? { item_id: ref.item_id } : { item_id: ref.item_id, version: ref.version })
  if (!answer || answer.item_id !== ref.item_id || ref.version !== undefined && answer.version !== ref.version) return null
  // The cached record of the same version is the same record, with where publication put it in the folder (`workspace`).
  const record = cached && cached.version === answer.version ? cached : answer
  const revision = held(mapping, ownerId, deviceId, record)
  if (revision && record !== cached) await cacheRevision(revision, ownerId, env)
  return revision
}

/**
 * 这个账号名下记过的全部「项目 → 群」。回收器用它当群投影的枚举面:项目没了、群还挂在映射里,就该
 * 归档 —— 哪怕那个项目的 agent 名册行早已一条不剩(以前只从名册行推「死项目的群」,名册一空这些群就
 * 永远收不到,spec「删除必同步」在群这一半也是漏的)。只回自己名下的条目:v1 的 unowned 条目归属未知,
 * 交给 readProjectGroupId 的认领路径。
 */
export async function listProjectGroupIds(
  ownerUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ projectId: string; chatId: string }>> {
  if (!ownerUserId) return []
  const mapping = await readMapping(env)
  return Object.entries(mapping.owners[ownerUserId] ?? {}).map(([projectId, chatId]) => ({ projectId, chatId }))
}
