// An agent born in a chat (`session_spawn` chat_id, an App's spawnAgent chat) joins that chat once, right after its
// identity is minted (`chat.add_group_agent`, as its owner, so the group's rules decide).
//
// Before: any error was logged and dropped, and the session ran on outside its group; every later message there failed
// with group_member_not_found. Now:
//   · a transaction the database rolled back for concurrency (40P01 deadlock, 40001 serialization) is retried on the
//     same schedule as the identity mint itself — add_group_agent replays as `already_member`, so a retry is safe;
//   · a join that still fails is kept on the agent's roster row (so it survives a restart) and announced, and the session
//     page shows it as a condition with a retry (`birthGroupJoin` / `retryBirthGroupJoin` on the shell port).
import { createGroupAdmin } from '@gugu/core/cloud/groupAdmin'
import { listAgents, updateAgent } from '@gugu/core'
import type { BirthGroup } from '../../src/session/shared/core/sessions/create-session'
import type { SessionShellBirthGroupJoin } from '../../src/session/shared/lib/ipc/shell-port'
import { localAgentForSession } from '@main/core/sessionpage/sessionpage-session-agent'
import { makeChatClient } from '../supabase'
import type { createLogger } from '../lib/logger'

/** Roster cache key: the birth chat this agent has not joined yet, and why (absent = nothing pending). */
export const BIRTH_GROUP_JOIN_CACHE_KEY = 'sessionpage_birth_group_join_failed'

type PendingJoin = BirthGroup & { reason: string }

/** SQLSTATEs for "the database rolled this transaction back because of a concurrent one; run it again". */
const TRANSIENT_CODES = new Set(['40P01', '40001'])

let retryDelaysMs: readonly number[] = [2_000, 8_000]
/** Tests only. */
export function setBirthGroupJoinRetryDelaysForTests(delays: readonly number[]): void {
  retryDelaysMs = delays
}

const listeners = new Set<(event: { sessionId: string; join: SessionShellBirthGroupJoin | null }) => void>()
/** A born-in-chat join failed, or a retry settled it (join null). Returns unsubscribe. */
export function onSessionpageBirthGroupJoin(
  listener: (event: { sessionId: string; join: SessionShellBirthGroupJoin | null }) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function pendingOf(cache: Record<string, unknown> | null | undefined): PendingJoin | null {
  const value = cache?.[BIRTH_GROUP_JOIN_CACHE_KEY] as Partial<PendingJoin> | undefined
  if (!value || typeof value.chatId !== 'string' || !value.chatId) return null
  return { chatId: value.chatId, asTask: value.asTask === true, reason: typeof value.reason === 'string' ? value.reason : '' }
}

/**
 * Joins `group` as `ownerUserId`; retries only transient rollbacks. Returns null when the group answered (joined, already a
 * member, or queued for approval — the group's own decision), else the error the last attempt ended with.
 */
async function attemptJoin(
  accessToken: string,
  ownerUserId: string,
  group: BirthGroup,
  agentUserId: string,
  log: ReturnType<typeof createLogger>,
): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await createGroupAdmin(makeChatClient(accessToken), ownerUserId).addAgent(group.chatId, agentUserId, { asTask: group.asTask })
      log.info({ agentUserId, chatId: group.chatId, asTask: group.asTask, status: data.status, attempt }, 'agent born in a chat: asked to join it, the group answered')
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = (error as { code?: unknown } | null)?.code
      const delay = typeof code === 'string' && TRANSIENT_CODES.has(code) ? retryDelaysMs[attempt] : undefined
      if (delay === undefined) {
        log.error({ agentUserId, chatId: group.chatId, code, attempt, error: message }, 'agent born in a chat could not join it')
        return message
      }
      log.warn({ agentUserId, chatId: group.chatId, code, attempt, error: message }, 'agent born in a chat: join rolled back by a concurrent transaction — retrying')
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

async function settle(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  agentUserId: string,
  pending: PendingJoin | null,
): Promise<SessionShellBirthGroupJoin | null> {
  const current = (await listAgents(env, { includeGuests: true })).find((a) => a.gugu_user_id === agentUserId)
  const cache: Record<string, unknown> = { ...(current?.cache ?? {}) }
  if (pending) cache[BIRTH_GROUP_JOIN_CACHE_KEY] = pending
  else delete cache[BIRTH_GROUP_JOIN_CACHE_KEY]
  await updateAgent({ guguUserId: agentUserId }, { cache }, env)
  const join = pending ? { chatId: pending.chatId, reason: pending.reason } : null
  for (const listener of listeners) {
    try { listener({ sessionId, join }) } catch { /* a listener's failure is its own */ }
  }
  return join
}

/** The first join, run by provisioning once the identity has landed. */
export async function joinBirthGroup(input: {
  env: NodeJS.ProcessEnv
  accessToken: string
  ownerUserId: string
  sessionId: string
  agentUserId: string
  group: BirthGroup | null | undefined
  log: ReturnType<typeof createLogger>
}): Promise<void> {
  const { group } = input
  if (!group) return
  const reason = await attemptJoin(input.accessToken, input.ownerUserId, group, input.agentUserId, input.log)
  if (reason === null) return
  // The identity itself landed; recording the failed join must not turn it into a failed mint.
  await settle(input.env, input.sessionId, input.agentUserId, { ...group, reason }).catch((error: unknown) => {
    input.log.error({ agentUserId: input.agentUserId, chatId: group.chatId, error: error instanceof Error ? error.message : String(error) },
      'agent born in a chat: could not record the failed join')
  })
}

/** What the session page shows: the birth chat this session's agent has not joined, or null. */
export async function sessionpageBirthGroupJoin(sessionId: string, env: NodeJS.ProcessEnv, ownerUserId: string): Promise<SessionShellBirthGroupJoin | null> {
  const pending = pendingOf((await localAgentForSession(sessionId, env, ownerUserId))?.cache)
  return pending ? { chatId: pending.chatId, reason: pending.reason } : null
}

/** The session page's retry: one more join (with the same transient retries); returns what is still pending. */
export async function retrySessionpageBirthGroupJoin(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  auth: { accessToken: string; userId: string },
  log: ReturnType<typeof createLogger>,
): Promise<SessionShellBirthGroupJoin | null> {
  const agent = await localAgentForSession(sessionId, env, auth.userId)
  const pending = pendingOf(agent?.cache)
  if (!agent?.gugu_user_id || !pending) return null
  const reason = await attemptJoin(auth.accessToken, auth.userId, pending, agent.gugu_user_id, log)
  return settle(env, sessionId, agent.gugu_user_id, reason === null ? null : { ...pending, reason })
}
