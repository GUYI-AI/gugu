import { eq } from 'drizzle-orm'
import { db } from '@main/db/client'
import { projects, sessions } from '@main/db/schema'
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

/** Grant subjects that identify this caller: its bound Agent and the project its session belongs to. */
export function passwordGrantSubjects(ownerId: string, agentId: string, sessionId: string): string[] {
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row || row.archivedAt || row.runtime !== 'acp') return []
  const bound = boundTaskName(sessionId)
  if (bound && (bound.ownerUserId !== ownerId || bound.agentUserId !== agentId)) return []
  return [`agent:${agentId}`, ...(row.projectId ? [`project:${row.projectId}`] : [])]
}

export interface PasswordGrantCandidate { subject: string; name: string; kind: 'agent' | 'project'; project?: string }
/** Who the person can authorize on a credential: their bound task Agents and their projects. Presentation only. */
export function passwordGrantCandidates(ownerId: string): PasswordGrantCandidate[] {
  const names = new Map(db.select({ id: projects.id, name: projects.name }).from(projects).all().map(row => [row.id, row.name]))
  const out = new Map<string, PasswordGrantCandidate>()
  for (const row of db.select({ id: sessions.id, projectId: sessions.projectId, runtime: sessions.runtime, archivedAt: sessions.archivedAt }).from(sessions).all()) {
    if (row.archivedAt || row.runtime !== 'acp') continue
    const bound = boundTaskName(row.id)
    if (!bound || bound.pending || bound.ownerUserId !== ownerId) continue
    const subject = `agent:${bound.agentUserId}`
    if (!out.has(subject)) out.set(subject, { subject, kind: 'agent', name: readable(bound.name, '未命名 Agent'), project: row.projectId ? names.get(row.projectId) : undefined })
  }
  const agents = [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  const list = [...names].map(([id, name]) => ({ subject: `project:${id}`, kind: 'project' as const, name: readable(name, '未命名项目') }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return [...list, ...agents]
}
