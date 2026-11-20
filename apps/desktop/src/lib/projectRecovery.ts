import { useSyncExternalStore } from 'react'
import { rpcOn } from '@/session/renderer/lib/ipc'
import type { UnavailableProject } from '@/session/shared/projects'
import { replica, useReplica } from './replica'
import { noteGroupArchived, readArchivedGroups, subscribeArchivedGroups } from './archivedGroupsRead'

const local = () => rpcOn(null).projects

/**
 * This computer's projects whose folder is gone: one read per account across both sidebar row trees. A return to the app
 * reads again (an Electron window stays visible while Finder has the focus; coming back must re-probe the folders).
 */
const unavailableProjects = replica({
  name: 'unavailableLocalProjects',
  scope: 'account',
  networkMode: 'always',
  fresh: Infinity,
  refreshOnFocus: true,
  read: () => local().listUnavailableProjects(),
})

export function useUnavailableProjects(enabled = true) {
  const archived = useSyncExternalStore(subscribeArchivedGroups, readArchivedGroups, readArchivedGroups)
  const reading = useReplica(unavailableProjects, enabled ? [] : null)
  // Not read (or not asked): no row is known to be unavailable, so none is drawn as one.
  return reading.state === 'value' ? reading.value.filter(project => !project.chatId || !archived.has(project.chatId)) : undefined
}

/** Read the folders again now and answer them; a failed read throws (a cleanup must not confirm from a stale list). */
export async function readUnavailableProjects(): Promise<UnavailableProject[]> {
  await unavailableProjects.refresh()
  // A failed refresh leaves the entry stale: `fetch` reads once more and throws its failure.
  return unavailableProjects.fetch()
}

export function projectRecoveryMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes('group_recovery_requires_topic_evidence')) return '恢复记录不完整，请联系维护者核对'
  if (error instanceof Error && ['请选择一个可用的文件夹。', '无法读取这个文件夹，请检查访问权限。', '这个文件夹已属于其他项目，请选择另一个文件夹。', '项目状态已变化，请重新确认。'].includes(error.message)) return error.message
  return '操作未完成，请检查文件夹访问权限和项目群权限后再试。'
}

async function groupIsArchived(chatId: string): Promise<boolean> {
  const { chatDb } = await import('./supabase')
  const { data, error } = await chatDb.from('chats').select('status').eq('id', chatId).maybeSingle()
  if (error || !data) throw new Error('无法核对原项目群。')
  if (data.status !== 'active' && data.status !== 'archived') throw new Error('原项目群暂时不可用。')
  return data.status === 'archived'
}

async function recoverFolder(project: UnavailableProject, path: string): Promise<void> {
  const checked = await local().inspectProjectRecovery(project.id, path)
  if (!checked.success) throw new Error(checked.error.message)
  // A refusal (including missing topic evidence) must leave the local project unchanged.
  if (project.chatId && await groupIsArchived(project.chatId)) {
    const { currentGroupAdmin } = await import('./groupAdmin')
    await (await currentGroupAdmin()).restore(project.chatId)
  }
  const result = await local().restoreProjectFolder(project.id, path)
  if (!result.success) throw new Error(result.error.message)
  if (project.chatId) noteGroupArchived(project.chatId, false)
  await refreshProjectRecovery()
}

export async function refreshProjectRecovery(): Promise<void> {
  await unavailableProjects.refresh()
}

export async function recoverUnavailableProject(project: UnavailableProject, path: string): Promise<void> {
  await recoverFolder(project, path)
}

/** The existing-folder action is the only post-cleanup recovery entry. No name/inode guessing. */
export async function recoverRetainedProjectAtPath(path: string): Promise<string | null> {
  const project = await local().findRetainedProjectAtPath(path)
  if (!project?.chatId || !await groupIsArchived(project.chatId)) return null
  await recoverFolder(project, path)
  return project.id
}

export async function archiveUnavailableProjects(confirmed: readonly UnavailableProject[]): Promise<void> {
  const current = await local().listUnavailableProjects()
  const eligible = new Map(current.map(project => [project.id, project]))
  if (confirmed.some(project => eligible.get(project.id)?.chatId !== project.chatId || eligible.get(project.id)?.path !== project.path)) throw new Error('项目状态已变化，请重新确认。')
  const { currentGroupAdmin } = await import('./groupAdmin')
  const admin = await currentGroupAdmin()
  for (const chatId of new Set(confirmed.flatMap(project => project.chatId ? [project.chatId] : []))) {
    if (readArchivedGroups().has(chatId)) continue
    await admin.archive(chatId)
    noteGroupArchived(chatId, true)
  }
  await refreshProjectRecovery()
}
