import { eq } from 'drizzle-orm'
import type { PasswordGrantCandidate } from '@gugu/core/shared/passwordBetaProtocol'
import { db } from '@main/db/client'
import { legacyProjectAliases, sessions } from '@main/db/schema'
import { boundTaskName, knownTaskName } from './task-name'

const readable = (value: string | undefined, fallback: string) => {
  const name = value?.trim()
  return name && !/^(?:(?:user|agent|session):)?[0-9a-f-]{36}$/i.test(name) ? name : fallback
}

/** Presentation only, read from the same native session/roster as the transcript header. Never an approval. */
export function passwordRequestPresentation(ownerId: string, agentId: string, sessionId: string) {
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row || row.archivedAt || row.runtime !== 'acp') throw new Error('password_presentation_unavailable')
  const bound = boundTaskName(sessionId)
  if (bound && (bound.ownerUserId !== ownerId || bound.agentUserId !== agentId)) throw new Error('password_presentation_unavailable')
  return {
    agentName: readable(bound?.name, '此 Agent'),
    sessionTitle: readable(knownTaskName(row), '当前会话'),
  }
}

/**
 * Grant subjects that identify this caller: its bound Agent and the group its session lives in (`chat:<id>`). Grants
 * given to a local project of an earlier release (`project:<id>`) still reach the sessions of the group that project
 * became (legacy aliases).
 */
export function passwordGrantSubjects(ownerId: string, agentId: string, sessionId: string): string[] {
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row || row.archivedAt || row.runtime !== 'acp') return []
  const bound = boundTaskName(sessionId)
  if (bound && (bound.ownerUserId !== ownerId || bound.agentUserId !== agentId)) return []
  if (!row.chatId) return [`agent:${agentId}`]
  const legacy = db.select({ id: legacyProjectAliases.projectId }).from(legacyProjectAliases)
    .where(eq(legacyProjectAliases.chatId, row.chatId)).all().map(alias => `project:${alias.id}`)
  return [`agent:${agentId}`, `chat:${row.chatId}`, ...legacy]
}

/**
 * Who the person can authorize on a credential: their bound task Agents and their groups (every task of a group,
 * `chat:<id>`). Presentation only. @@@group-folders — the groups are the account's groups with a folder bound on one of
 * its devices; their names are the account's (`groups`, my_chat_folders), not known on this machine alone.
 */
export async function passwordGrantCandidates(ownerId: string, groups: () => Promise<Array<{ chatId: string; name: string; archived: boolean }>>): Promise<PasswordGrantCandidate[]> {
  const out = new Map<string, PasswordGrantCandidate>()
  for (const row of db.select({ id: sessions.id, runtime: sessions.runtime, archivedAt: sessions.archivedAt }).from(sessions).all()) {
    if (row.archivedAt || row.runtime !== 'acp') continue
    const bound = boundTaskName(row.id)
    if (!bound || bound.pending || bound.ownerUserId !== ownerId) continue
    const subject = `agent:${bound.agentUserId}`
    if (!out.has(subject)) out.set(subject, { subject, kind: 'agent', name: readable(bound.name, '未命名 Agent') })
  }
  const agents = [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  const list = (await groups()).filter(group => !group.archived)
    .map(group => ({ subject: `chat:${group.chatId}`, kind: 'group' as const, name: readable(group.name, '未命名群') }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return [...list, ...agents]
}
