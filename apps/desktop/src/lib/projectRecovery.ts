import { useSyncExternalStore } from 'react'
import { rpcOn } from '@/session/renderer/lib/ipc'
import type { ProjectRecoveryError, UnavailableProject } from '@/session/shared/projects'
import { i18n } from '@/i18n/runtime'
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
export function readUnavailableProjects(): Promise<UnavailableProject[]> {
  return unavailableProjects.reread()
}

type RefusalType = ProjectRecoveryError['type'] | 'state-changed'

/** A refusal the person can act on; its type picks the catalog line, its message stays the diagnostic. */
export class ProjectRecoveryRefusal extends Error {
  constructor(readonly type: RefusalType, message: string) { super(message) }
}

const refusalKeys: Partial<Record<RefusalType, string>> = {
  'invalid-directory': 'invalidDirectory', 'inspect-failed': 'inspectFailed', 'path-conflict': 'pathConflict', 'state-changed': 'stateChanged',
}

export function projectRecoveryMessage(error: unknown): string {
  const t = (key: string) => i18n.t(`projectRecovery.${key}`, { ns: 'messaging' })
  if (error instanceof Error && error.message.includes('group_recovery_requires_topic_evidence')) return t('incompleteHistory')
  const key = error instanceof ProjectRecoveryRefusal ? refusalKeys[error.type] : undefined
  return t(key ?? 'failed')
}

async function groupIsArchived(chatId: string): Promise<boolean> {
  const { chatDb } = await import('./supabase')
  const { data, error } = await chatDb.from('chats').select('status').eq('id', chatId).maybeSingle()
  if (error || !data) throw new Error(`project group ${chatId} could not be read`)
  if (data.status !== 'active' && data.status !== 'archived') throw new Error(`project group ${chatId} is ${data.status}`)
  return data.status === 'archived'
}

export async function recoverUnavailableProject(project: UnavailableProject, path: string): Promise<void> {
  const checked = await local().inspectProjectRecovery(project.id, path)
  if (!checked.success) throw new ProjectRecoveryRefusal(checked.error.type, checked.error.message)
  // A refusal (including missing topic evidence) must leave the local project unchanged.
  if (project.chatId && await groupIsArchived(project.chatId)) {
    const { currentGroupAdmin } = await import('./groupAdmin')
    await (await currentGroupAdmin()).restore(project.chatId)
  }
  const result = await local().restoreProjectFolder(project.id, path)
  if (!result.success) throw new ProjectRecoveryRefusal(result.error.type, result.error.message)
  if (project.chatId) noteGroupArchived(project.chatId, false)
  await unavailableProjects.refresh()
}

/** The existing-folder action is the only post-cleanup recovery entry. No name/inode guessing. */
export async function recoverRetainedProjectAtPath(path: string): Promise<string | null> {
  const project = await local().findRetainedProjectAtPath(path)
  if (!project?.chatId || !await groupIsArchived(project.chatId)) return null
  await recoverUnavailableProject(project, path)
  return project.id
}

export async function archiveUnavailableProjects(confirmed: readonly UnavailableProject[]): Promise<void> {
  // Checked against the list read now (the shown one may be minutes old).
  const current = await readUnavailableProjects()
  const eligible = new Map(current.map(project => [project.id, project]))
  if (confirmed.some(project => eligible.get(project.id)?.chatId !== project.chatId || eligible.get(project.id)?.path !== project.path)) throw new ProjectRecoveryRefusal('state-changed', 'unavailable projects changed after confirmation')
  const { currentGroupAdmin } = await import('./groupAdmin')
  const admin = await currentGroupAdmin()
  for (const chatId of new Set(confirmed.flatMap(project => project.chatId ? [project.chatId] : []))) {
    if (readArchivedGroups().has(chatId)) continue
    await admin.archive(chatId)
    noteGroupArchived(chatId, true)
  }
  await unavailableProjects.refresh()
}
