/**
 * #113 项目记在账号上(product spec「项目」:项目不属于任何一台机器)。
 *
 * 每台机器把自己的本地项目 —— 名字、根目录、建立时间、绑的项目群、挂的文件夹 —— 整份记到账号上
 * (identity.device_projects,一项目一行,只有本人读得到);别的端打开时从账号读到完整的项目与文件夹,
 * 那台机器此刻离线也照样列出来,不靠这一端从前问到过。写只有一条路:那台机器自己整份替换
 * (identity.publish_device_projects_v2),变了才推进账号 revision(device_changed,与设备行同一个信号)。
 * 绑到不归这个账号的群上的那几行,账号不认那个群:行照记、群不记,并把这几个本地项目报回来(rejected)。
 */
import type { AbortablePromiseLike } from './boundedOperation'
import type { Device } from '../shared/types/chat'
import type { DeviceProject, DeviceProjectFolder } from '../shared/types/deviceProject'

export type { DeviceProject, DeviceProjectFolder, DeviceProjectFolderKind } from '../shared/types/deviceProject'

type RpcResult = { data: unknown; error: { message: string } | null }
type PageResult = RpcResult & { count?: number | null }

export interface DeviceProjectsRpcClient {
  rpc(fn: 'publish_device_projects_v2', args: { p_device_id: string; p_projects: unknown[] }): AbortablePromiseLike<RpcResult>
}

type DeviceProjectsPage = {
  in(column: 'device_id', values: readonly string[]): DeviceProjectsPage
  order(column: 'device_id' | 'local_project_id'): DeviceProjectsPage
  range(from: number, to: number): PromiseLike<PageResult>
}

export interface DeviceProjectsTableClient {
  from(table: 'device_projects'): {
    select(columns: string, options: { count: 'exact' }): {
      eq(column: 'user_id', value: string): DeviceProjectsPage
    }
  }
}

/** What the account made of a publish: whether its copy changed, and the local projects whose group it refused. */
export type DeviceProjectsPublished = { changed: boolean; rejected: string[] }

/** 这台机器的项目整份记到账号上(没列进来的那台机器上的项目从账号上删掉)。 */
export async function publishDeviceProjects(
  client: DeviceProjectsRpcClient,
  deviceId: string,
  projects: readonly DeviceProject[],
  /** 等太久就作废这次请求(见 deviceProjectsPublisher)。 */
  signal?: AbortSignal,
): Promise<DeviceProjectsPublished> {
  const request = client.rpc('publish_device_projects_v2', {
    p_device_id: deviceId,
    p_projects: projects.map((project) => ({
      local_project_id: project.localProjectId,
      name: project.name,
      root_path: project.rootPath,
      created_at: project.createdAt,
      chat_id: project.chatId,
      folders: project.folders.map((folder) => ({
        workspace_id: folder.workspaceId,
        kind: folder.kind,
        path: folder.path,
        attached_at: folder.attachedAt,
      })),
    })),
  })
  const { data, error } = await (signal && request.abortSignal ? request.abortSignal(signal) : request)
  if (error) throw new Error(error.message)
  const reply = data as { changed?: unknown; rejected?: unknown } | null
  if (typeof reply?.changed !== 'boolean' || !Array.isArray(reply.rejected) || !reply.rejected.every((id) => typeof id === 'string' && id)) {
    throw new Error('Device project publish response must be {changed, rejected}')
  }
  return { changed: reply.changed, rejected: reply.rejected as string[] }
}

const DEVICE_PROJECT_COLUMNS = 'device_id, local_project_id, name, root_path, created_at, chat_id, folders'
export const DEVICE_PROJECT_PAGE_ROWS = 1000

/**
 * 账号上记着的每台机器的项目:deviceId → 项目(新建的在前)。没记过项目的机器不在其中。
 * 一次请求最多回服务端设的那么多行(社区默认 1000),❌ 只读第一页、悄悄少列:按 (设备, 项目) 排好一页页往后读,
 * 头一页带回总行数,读满为止。读的途中那份变了(行数对不上、同一行出现两次)= 这一次没读到 —— 变了的那台会推进
 * 账号 revision,设备列表跟着再读一次。
 */
export async function listDeviceProjects(
  client: DeviceProjectsTableClient,
  ownerId: string,
  /** Only these devices' projects (a device_changed revision names the device whose projects changed). */
  deviceIds?: readonly string[],
): Promise<Record<string, DeviceProject[]>> {
  if (!ownerId) throw new Error('listDeviceProjects requires ownerId')
  const rows: unknown[] = []
  let total: number | null = null
  while (total === null || rows.length < total) {
    const owned = client
      .from('device_projects')
      .select(DEVICE_PROJECT_COLUMNS, { count: 'exact' })
      .eq('user_id', ownerId)
    const { data, error, count } = await (deviceIds ? owned.in('device_id', deviceIds) : owned)
      .order('device_id')
      .order('local_project_id')
      .range(rows.length, rows.length + DEVICE_PROJECT_PAGE_ROWS - 1)
    if (error) throw new Error(error.message)
    if (!Array.isArray(data)) throw new Error('Device project list response must be an array')
    if (typeof count !== 'number') throw new Error('Device project list response has no row count')
    if (total !== null && count !== total) throw new Error('Device project list changed while it was being read')
    total = count
    if (data.length === 0 && rows.length < total) throw new Error('Device project list changed while it was being read')
    rows.push(...data)
  }
  const byDevice: Record<string, DeviceProject[]> = {}
  const seen = new Set<string>()
  for (const row of rows) {
    const { deviceId, project } = normalizeDeviceProjectRow(row)
    const key = `${deviceId}\u0000${project.localProjectId}`
    if (seen.has(key)) throw new Error('Device project list changed while it was being read')
    seen.add(key)
    ;(byDevice[deviceId] ??= []).push(project)
  }
  for (const projects of Object.values(byDevice)) {
    projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.localProjectId.localeCompare(b.localProjectId))
  }
  return byDevice
}

/**
 * 一行读不懂就整份算读不到(❌ 丢掉那一行):账号上的行只由 publish_device_projects 写、写前逐项验过,
 * 读不懂只会是两边版本对不上 —— 那时悄悄少列一个项目,比明说「读不到」更误导。
 */
export function normalizeDeviceProjectRow(value: unknown): { deviceId: string; project: DeviceProject } {
  if (!value || typeof value !== 'object') throw new Error('Device project row is missing')
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.folders)) throw new Error('Device project row has no folder list')
  const createdAt = text(row.created_at, 'created_at')
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Device project row has an invalid created_at')
  return {
    deviceId: text(row.device_id, 'device_id'),
    project: {
      localProjectId: text(row.local_project_id, 'local_project_id'),
      name: projectName(row.name),
      rootPath: text(row.root_path, 'root_path'),
      createdAt: new Date(createdAt).toISOString(),
      chatId: row.chat_id === null || row.chat_id === undefined ? null : text(row.chat_id, 'chat_id'),
      folders: row.folders.map(normalizeFolder),
    },
  }
}

function normalizeFolder(value: unknown): DeviceProjectFolder {
  if (!value || typeof value !== 'object') throw new Error('Device project folder is missing')
  const folder = value as Record<string, unknown>
  if (folder.kind !== 'root' && folder.kind !== 'attached') throw new Error('Device project folder has an unknown kind')
  return {
    workspaceId: text(folder.workspace_id, 'workspace_id'),
    kind: folder.kind,
    path: text(folder.path, 'path'),
    attachedAt: folder.attached_at === null || folder.attached_at === undefined ? null : text(folder.attached_at, 'attached_at'),
  }
}

// 名字可以是空串(那台机器上就叫这个),但得是字符串。
function projectName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Device project row has no name')
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Device project row has no ${field}`)
  return value
}

/**
 * 设备列表配上账号上记着的项目。`projects` 为 null = 这一次没读到:每台沿用上一份读到的(与设备列表读不到时
 * 留着上一份同理);从没读到过的那台就缺这一格,由用到的地方说「读不到」。读到了而那台没记过项目 = 空列表。
 */
export function withDeviceProjects<T extends Pick<Device, 'device_id' | 'projects'>>(
  devices: readonly T[],
  projects: Readonly<Record<string, DeviceProject[]>> | null,
  previous: readonly Pick<Device, 'device_id' | 'projects'>[],
  /** `projects` was read for these devices only; the others keep their previous projects. */
  readFor?: ReadonlySet<string>,
): T[] {
  return devices.map((device) => {
    const read = projects && (!readFor || readFor.has(device.device_id))
    const known = read ? (projects[device.device_id] ?? []) : previous.find((row) => row.device_id === device.device_id)?.projects
    const { projects: _stale, ...rest } = device
    return (known ? { ...rest, projects: known } : rest) as T
  })
}

/** 账号上的一个项目(就是它的项目群):名字与状态是群自己的,`bindings` = 这个账号各台机器上为它记着的本地项目。 */
export type AccountProject = {
  chatId: string
  name: string
  archived: boolean
  bindings: Array<{ deviceId: string; localProjectId: string }>
}

export interface AccountProjectsRpcClient {
  rpc(fn: 'list_my_projects'): PromiseLike<RpcResult>
}

/** identity.list_my_projects:这个账号建的 / 当群主的项目群,连同各台机器上的文件夹(一个都没有也是项目)。 */
export async function listAccountProjects(client: AccountProjectsRpcClient): Promise<AccountProject[]> {
  const { data, error } = await client.rpc('list_my_projects')
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error('Account project list response must be an array')
  return data.map((row) => {
    const value = row as { chat_id?: unknown; name?: unknown; status?: unknown; bindings?: unknown }
    if (typeof value.chat_id !== 'string') throw new Error('Account project row has no chat_id')
    const bindings = Array.isArray(value.bindings) ? value.bindings : []
    return {
      chatId: value.chat_id,
      name: typeof value.name === 'string' ? value.name : '',
      archived: value.status === 'archived',
      bindings: bindings.flatMap((binding) => {
        const b = binding as { device_id?: unknown; local_project_id?: unknown }
        return typeof b.device_id === 'string' && typeof b.local_project_id === 'string'
          ? [{ deviceId: b.device_id, localProjectId: b.local_project_id }] : []
      }),
    }
  })
}
