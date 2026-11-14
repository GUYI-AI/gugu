import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project'
import { randomUUID } from 'node:crypto'
import type { AttachProjectFolderError, ProjectFolder } from '@shared/core/projects/project-folders'
import type { LocalProject } from '@shared/projects'
import { linkFolderOnMachine } from '@shared/core/projects/project-attach-flow'
import { sameFolder } from '@shared/core/projects/folder-path'
import { localProjectOf, localProjectsOf, outwardProjectIds } from './project-public-id'

type Answer<T, E extends { type?: string; message?: string } = { type?: string; message?: string }> =
  | { success: true; data: T }
  | { success: false; error: E }
export type ProjectAgentAction =
  | { action: 'project_list' }
  | { action: 'project_create'; name: string; path: string }
  | { action: 'project_get'; project_id?: string }
  | { action: 'project_add_folder'; project_id?: string; path: string; merge_existing?: boolean; source_project_id?: string }
  | { action: 'project_remove_folder'; project_id?: string; folder_id: string }
  | { action: 'project_remove_device'; project_id?: string; path?: string }
  | { action: 'project_restore_device'; project_id?: string; path: string; expected_chat_id: string | null }
  | { action: 'project_prepare_device'; project_id?: string }
  // Machine-to-machine (project-device-link.ts), never an agent's tool: `chat_id` is the wire name released hosts read.
  | { action: 'project_bind_folder'; chat_id: string; name: string; path: string; merge_existing?: boolean }
  | { action: 'project_add_device'; project_id?: string; target_device: string; path: string; merge_existing?: boolean }

export interface ProjectAgentOps {
  list(): Promise<LocalProject[]>
  get(id: string): Promise<LocalProject | undefined>
  create(name: string, path: string, id?: string): Promise<Answer<LocalProject>>
  folders(id: string): Promise<Answer<ProjectFolder[]>>
  attach(id: string, path: string): Promise<Answer<ProjectFolder, AttachProjectFolderError>>
  detach(id: string, folderId: string): Promise<Answer<void>>
  bindings(): Promise<Answer<Array<{ projectId: string; chatId: string }>>>
  localProjectOfGroup(chatId: string): Promise<Answer<string | undefined>>
  ensureGroup(id: string): Promise<Answer<{ chatId: string }>>
  bind(id: string, chatId: string, expectedChatId?: string | null): Promise<Answer<unknown>>
  unbind(id: string): Promise<Answer<{ expectedChatId: string | null }>>
  inspect(path: string): Promise<{ isDirectory: boolean; existingProject?: LocalProject }>
  sessionCount(id: string): Promise<number>
  delete(id: string): Promise<void>
}

function value<T, E extends { type?: string; message?: string }>(answer: Answer<T, E>): T {
  if (!answer.success) throw new Error(answer.error.message ?? answer.error.type ?? 'Project operation failed')
  return answer.data
}

async function localOps(): Promise<ProjectAgentOps> {
  const [{ getProjects, getProjectById }, { createProject, inspectProjectPath }, folders, groups, { deleteProject }, { db }, { sessions }, { eq, isNull, and }] = await Promise.all([
    import('./operations/getProjects'), import('./operations/createProject'), import('./operations/project-folders'), import('./operations/project-groups'), import('./operations/deleteProject'), import('@main/db/client'), import('@main/db/schema'), import('drizzle-orm'),
  ])
  return {
    list: getProjects, get: getProjectById,
    create: (name, path, id) => createProject({ id, type: 'local', name, path, allowNonGit: true, initGitRepository: false, createDirectory: false }),
    folders: folders.listProjectFolders, attach: folders.attachProjectFolder, detach: folders.detachProjectFolder,
    bindings: groups.listProjectGroupBindings, localProjectOfGroup: groups.localProjectOfGroup,
    ensureGroup: groups.ensureProjectGroup, bind: groups.bindProjectToGroup, unbind: groups.unbindProjectGroupForAgent,
    inspect: (path) => inspectProjectPath({ type: 'local', path }), delete: deleteProject,
    sessionCount: async (id) => (await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.projectId, id), isNull(sessions.archivedAt)))).length,
  }
}

const row = (project: LocalProject, projectId: string | null) => ({ project_id: projectId, name: project.name, path: project.path })
const notice = (chatId: string | null | undefined, text: string) => chatId ? { chat_id: chatId, text } : null

/**
 * Outward, a project is its project group (`project_id` = chat id, project-public-id.ts); local project ids never appear
 * in a result. Inward, `project_id` resolves here, on the device that owns the folders.
 */
export async function runProjectAgentAction(context: { projectId?: string }, action: ProjectAgentAction, ops?: ProjectAgentOps): Promise<unknown> {
  const api = ops ?? await localOps()
  const deps = { bindings: async () => value(await api.bindings()), get: api.get }
  // #609 workspace(任务工作区、~、助理与 App 的目录)不是项目,不列。A local project in no project group is no project either.
  if (action.action === 'project_list') {
    const bindings = await deps.bindings()
    const outward = outwardProjectIds(bindings)
    const rows: Array<ReturnType<typeof row>> = []
    const seen = new Set<string>()
    for (const project of await api.list()) {
      const chatId = outward(project.id)
      if (project.kind === 'workspace' || isImplicitSessionHomeProjectId(project.id) || !chatId || seen.has(chatId)) continue
      seen.add(chatId)
      const primary = await localProjectOf(chatId, { bindings: async () => bindings, get: api.get })
      rows.push(row(primary === project.id ? project : await api.get(primary) ?? project, chatId))
    }
    return rows
  }
  if (action.action === 'project_create') {
    const project = value(await api.create(action.name, action.path))
    const chatId = value(await api.ensureGroup(project.id)).chatId
    return { ...row(project, chatId), group_notice: notice(chatId, `创建了项目「${project.name}」，根目录是 ${project.path}。`) }
  }
  if (action.action === 'project_bind_folder') return bindFolder(action, api)
  if (action.action === 'project_add_device') throw new Error('project_add_device must be routed through the device host')

  // The project: named, or the calling session's own (which may be in no project group: then it has no outward id).
  // Bindings are read once: an undo checkpoint must be the state before this call's own change.
  if (!action.project_id && !context.projectId) throw new Error('project_id is required when operating on another device')
  const all = await deps.bindings()
  const here = { bindings: async () => all, get: api.get }
  const chatId = action.project_id ?? outwardProjectIds(all)(context.projectId!)
  const locals = chatId ? await localProjectsOf(chatId, here) : [context.projectId!]
  if (action.action === 'project_restore_device') {
    if (!chatId) throw new Error('project_id is required: the project to restore into')
    const source = (await api.inspect(action.path)).existingProject
    if (!source || !sameFolder(source.path, action.path)) throw new Error(`No project root at ${action.path} on this device`)
    value(await api.bind(source.id, chatId, action.expected_chat_id))
    return { ...row(source, chatId), restored: true, group_notice: notice(chatId, `恢复了这台设备上的「${source.name}」与共享项目的关联。`), undo: { tool: 'project_remove_device', project_id: chatId, path: source.path } }
  }
  if (!locals.length) throw new Error(`This device has no folder for project:${chatId}. Link one with project_add_device`)
  const id = locals[0]!
  const project = await api.get(id)
  if (!project) throw new Error(`Project not found: ${id}`)
  if (action.action === 'project_prepare_device') {
    const group = chatId ?? value(await api.ensureGroup(id)).chatId
    // project_prepare_device's answer is read by released hosts' project_add_device as `chat_id`.
    return { ...row(project, group), chat_id: group }
  }
  const foldersOf = async () => (await Promise.all(locals.map(async (local) => value(await api.folders(local)).map((folder) => ({ ...folder, owner: local }))))).flat()
  if (action.action === 'project_get') return { ...row(project, chatId), folders: (await foldersOf()).map((f) => ({ folder_id: f.workspaceId, path: f.path, kind: f.kind, branch: f.branch, sessions: f.sessionIds.map((session_id) => ({ session_id })) })) }
  if (action.action === 'project_add_folder') {
    if (action.merge_existing || action.source_project_id) {
      if (!action.merge_existing || !action.source_project_id) {
        throw new Error('确认已有项目归并时，需要同时提供 merge_existing:true 和 source_project_id')
      }
      const inspection = await api.inspect(action.path)
      if (!inspection.isDirectory || !inspection.existingProject || !sameFolder(inspection.existingProject.path, action.path) ||
          outwardProjectIds(all)(inspection.existingProject.id) !== action.source_project_id) {
        throw new Error('这个目录的项目归属已经变化，请重新读取后确认')
      }
      return attachExistingProjectRoot(project, chatId, action, inspection.existingProject.id, api)
    }
    const already = (await foldersOf()).find((folder) => sameFolder(folder.path, action.path))
    if (already) return { ...row(project, chatId), folder_id: already.workspaceId, path: already.path, already_attached: true }
    const attached = await api.attach(id, action.path)
    if (!attached.success && attached.error.type === 'is-project-root') {
      return attachExistingProjectRoot(project, chatId, action, attached.error.projectId, api)
    }
    const folder = value(attached)
    const group = chatId ?? value(await api.ensureGroup(id)).chatId
    return { ...row(project, group), folder_id: folder.workspaceId, path: folder.path, group_notice: notice(group, `把文件夹 ${folder.path} 挂进了项目「${project.name}」。`), undo: { tool: 'project_remove_folder', project_id: group, folder_id: folder.workspaceId } }
  }
  if (action.action === 'project_remove_folder') {
    const folder = (await foldersOf()).find((f) => f.workspaceId === action.folder_id)
    if (!folder) throw new Error(`Folder not found in project: ${action.folder_id}`)
    value(await api.detach(folder.owner, action.folder_id))
    return { ...row(project, chatId), detached: folder.path, group_notice: notice(chatId, `从项目「${project.name}」摘下了文件夹 ${folder.path}，文件和已有会话保留。`), undo: { tool: 'project_add_folder', ...(chatId ? { project_id: chatId } : {}), path: folder.path } }
  }
  // project_remove_device: one of this device's folder bindings of the project, picked by its root path when there are several.
  if (!chatId) return { ...row(project, null), unlinked: false, already_unlinked: true }
  let local = project
  if (action.path) {
    const named = (await api.inspect(action.path)).existingProject
    if (!named || !sameFolder(named.path, action.path) || !locals.includes(named.id)) throw new Error(`${action.path} is not a root folder of project:${chatId} on this device`)
    local = named
  } else if (locals.length > 1) {
    const roots = await Promise.all(locals.map(async (other) => (await api.get(other))?.path ?? other))
    throw new Error(`This device has several folders in project:${chatId}; pass path, one of: ${roots.join(', ')}`)
  }
  const { expectedChatId } = value(await api.unbind(local.id))
  return { ...row(local, chatId), unlinked: true, group_notice: notice(chatId, `把这台设备上的「${local.name}」从共享项目中解除关联，文件和会话保留。`), undo: { tool: 'project_restore_device', project_id: chatId, path: local.path, expected_chat_id: expectedChatId } }
}

async function attachExistingProjectRoot(
  target: LocalProject,
  targetChatId: string | null,
  action: Extract<ProjectAgentAction, { action: 'project_add_folder' }>,
  sourceId: string,
  api: ProjectAgentOps,
): Promise<unknown> {
  const source = await api.get(sourceId)
  if (!source) throw new Error(`Project not found: ${sourceId}`)
  const sourceFolders = value(await api.folders(sourceId))
  const root = sourceFolders.find((folder) => folder.kind === 'root' && sameFolder(folder.path, action.path))
  if (!root) throw new Error('这个目录已不再是原项目的根目录，请重新读取项目')
  if (sourceId === target.id) return { ...row(target, targetChatId), folder_id: root.workspaceId, path: root.path, already_attached: true }

  const sourceChatId = outwardProjectIds(value(await api.bindings()))(sourceId)
  if (targetChatId && sourceChatId === targetChatId) {
    return { ...row(target, targetChatId), source_project_id: sourceChatId, folder_id: root.workspaceId, path: root.path, already_attached: true }
  }
  const sessions = await api.sessionCount(sourceId)
  if (sessions > 0 && !action.merge_existing) {
    // The confirmation names the source by its project id; one with sessions but no group (unlinked earlier) gets its group now.
    const sourceProjectId = sourceChatId ?? value(await api.ensureGroup(sourceId)).chatId
    return {
      ...row(target, targetChatId), needs_confirmation: true, source_project_id: sourceProjectId, source_name: source.name,
      source_folders: sourceFolders.map((folder) => folder.path), sessions,
      message: `先征得 owner 同意：将项目「${source.name}」的 ${sourceFolders.length} 个目录和 ${sessions} 条会话接入「${target.name}」的项目群；文件、会话和原群历史保留。`,
    }
  }
  if (action.merge_existing && action.source_project_id !== sourceChatId) {
    throw new Error('merge_existing:true 需要带上确认结果中的 source_project_id')
  }
  const group = value(await api.ensureGroup(target.id)).chatId
  value(await api.bind(sourceId, group, sourceChatId))
  return {
    ...row(target, group), ...(sourceChatId ? { source_project_id: sourceChatId } : {}), folder_id: root.workspaceId, path: root.path,
    group_notice: notice(group, `把这台设备上的项目「${source.name}」及其 ${sourceFolders.length} 个目录接进了项目「${target.name}」，文件、会话和原群历史保留。`),
    undo: sourceChatId
      ? { tool: 'project_restore_device', project_id: sourceChatId, path: root.path, expected_chat_id: group }
      : { tool: 'project_remove_device', project_id: group, path: root.path },
  }
}

async function bindFolder(action: Extract<ProjectAgentAction, { action: 'project_bind_folder' }>, api: ProjectAgentOps): Promise<unknown> {
  const projectId = value(await api.localProjectOfGroup(action.chat_id))
  if (projectId) {
    const already = value(await api.folders(projectId)).find((f) => sameFolder(f.path, action.path))
    if (already) return { project_id: action.chat_id, folder_id: already.workspaceId, path: already.path, already_attached: true }
    const folder = value(await api.attach(projectId, action.path))
    return { project_id: action.chat_id, folder_id: folder.workspaceId, path: folder.path, group_notice: notice(action.chat_id, `把这台设备上的 ${folder.path} 挂进了项目「${action.name}」。`), undo: { tool: 'project_remove_folder', project_id: action.chat_id, folder_id: folder.workspaceId } }
  }
  const existing = (await api.inspect(action.path)).existingProject
  if (existing && !sameFolder(existing.path, action.path)) throw new Error(`Folder already belongs to project ${existing.name}`)
  const count = existing ? await api.sessionCount(existing.id) : 0
  if (existing && count > 0 && !action.merge_existing) return { needs_confirmation: true, project_id: action.chat_id, source_name: existing.name, path: existing.path, sessions: count, message: 'This folder\'s project has sessions. Ask the owner before merging its agents into the shared project group.' }
  const linked = await linkFolderOnMachine({
    ensureGroup: async () => ({ success: true, data: { chatId: action.chat_id } }),
    createProjectOn: async () => {
      const requestedId = randomUUID()
      const project = value(await api.create(action.name, action.path, requestedId))
      return { projectId: project.id, created: project.id === requestedId }
    },
    bind: (_machine, id, chatId) => api.bind(id, chatId), unbind: (_machine, id) => api.unbind(id), deleteProject: api.delete,
    sessionCountOf: api.sessionCount,
  }, { rowId: '', machine: null, path: action.path })
  if (!linked.ok) throw linked.error
  return { project_id: action.chat_id, path: action.path, group_notice: notice(action.chat_id, `把这台设备上的 ${action.path} 接进了项目「${action.name}」。`), undo: { tool: 'project_remove_device', project_id: action.chat_id, path: action.path } }
}

export function isProjectAgentAction(action: { action: string }): action is ProjectAgentAction {
  return action.action.startsWith('project_')
}
