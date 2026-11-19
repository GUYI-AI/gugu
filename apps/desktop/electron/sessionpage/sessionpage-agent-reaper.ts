import { releaseAgentLocalFootprint } from './agent-local-footprint'
// Reconcile missing local tasks by archival. Missing inventory never authorizes
// deleting cloud identities or group membership. Missing projects are logged; group state and mappings stay intact.
import { listAgents } from '@gugu/core'
import { agentsForOwner } from '@gugu/core/local/state/agentOwner'
import {
  SESSION_CACHE_KEY,
  GROUP_CACHE_KEY,
  OWNER_CACHE_KEY,
  PARKED_SESSION_CACHE_KEY,
  PROJECT_CACHE_KEY,
  cacheString,
} from './emdash-agent-provisioning'
import { emdashAgentRegistry } from './emdash-agent-registry'
import { createLogger } from '../lib/logger'
import { listProjectGroupIds } from './sessionpage-project-groups'

/** The existence inventory includes archived conversations and their retained identities. */
export interface SessionpageInventory {
  sessionIds: string[]
  projectIds: string[]
}

export interface SessionpageReapDeps {
  onFailure?: (operation: string, taskId: string, error: unknown) => void
  getAuth: () => Promise<{ accessToken: string; refreshToken: string; userId: string } | null>
  resolveDeviceId: () => Promise<string | null>
  getInventory: () => Promise<SessionpageInventory>
  /** Dispose the runtime session bound to a conversation (codex app-server). Injected by main.ts so this
   *  module doesn't depend on the pty provisioning module. */
  disposeSession?: (sessionId: string) => Promise<void>
  /**
   * #7341 归档项目群之前问一句:群里还有没有别的机器上的 agent(`identity.users.device_id` ≠ 本机)。
   * 返回那些 agent 的 id;缺席 ⇒ 走 supabase(listGroupAgentsOnOtherDevices)。测试注入用。
   */
  listGroupAgentsElsewhere?: (input: { chatId: string; deviceId: string; accessToken: string; ownerUserId: string }) => Promise<string[]>
  env?: NodeJS.ProcessEnv
}

export interface SessionpageReapResult {
  /** 名册段:名册行还在、会话没了的 agent。 */
  reapedAgents: number
  archivedGroups: number
}

/** 读群成员 / 读身份行用到的那一小片 supabase 查询面(测试拿替身喂)。 */
interface MembersQuery {
  from(table: 'active_members'): {
    select(columns: 'user_id'): {
      eq(column: 'chat_id', value: string): PromiseLike<{ data: unknown; error: { message: string } | null }>
    }
  }
}
interface UsersQuery {
  from(table: 'users'): {
    select(columns: 'id, type, device_id'): {
      in(column: 'id', values: string[]): PromiseLike<{ data: unknown; error: { message: string } | null }>
    }
  }
}

/**
 * #7341 这个群里家在**别的机器**上的 agent(product spec:一台机器上的项目没了,❌ 连带把还有别的机器在用的
 * 项目群归档)。成员行 RLS 是「我也在这个群里」,群主读得到全部成员;identity.users 的 id/type/device_id 对已登录者可读。
 * 人不算(只看 type=agent);本机的 agent 不算(它们的本机运行态会归档,群成员保留)。任何一步读失败都抛 ——
 * 调用方据此「不归档」,❌ 当成「没人在用」。
 */
export async function listGroupAgentsOnOtherDevices(input: {
  chat: MembersQuery
  /** 惰性:群里除了主人没别人时不必建身份查询的客户端。 */
  identity: () => UsersQuery
  chatId: string
  deviceId: string
  ownerUserId: string
}): Promise<string[]> {
  const { data: members, error } = await input.chat.from('active_members').select('user_id').eq('chat_id', input.chatId)
  if (error) throw new Error(`read members of group ${input.chatId}: ${error.message}`)
  const ids = [...new Set(((members as Array<{ user_id?: unknown }> | null) ?? [])
    .map((row) => (typeof row.user_id === 'string' ? row.user_id : ''))
    .filter((id) => id && id !== input.ownerUserId))]
  if (!ids.length) return []
  const { data: users, error: usersError } = await input.identity().from('users').select('id, type, device_id').in('id', ids)
  if (usersError) throw new Error(`read member identities of group ${input.chatId}: ${usersError.message}`)
  return ((users as Array<{ id: string; type?: string | null; device_id?: string | null }> | null) ?? [])
    .filter((user) => user.type === 'agent' && user.device_id !== input.deviceId)
    .map((user) => user.id)
}

// Serialize: several triggers can fire back-to-back (deleting a project tears down each of its tasks), and
// concurrent passes would both see the same stale rows and race on removing them.
let reapChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = reapChain.then(fn, fn)
  reapChain = next.catch(() => undefined)
  return next
}

/**
 * Reconcile gugu's social-side projection with the session page. Reaps every session-page agent whose
 * conversation no longer exists (deleted). Missing projects are reported without archiving groups
 * or forgetting their mappings. Returns what it reconciled. Throws (aggregated) if any removal failed.
 */
/**
 * #3969 —— 「会话清单读空」能不能授权删除。
 *
 * 回收器 diff 花名册与会话页后端清单,不在清单里的 bound agent 会被删花名册 **并删云端身份**。
 * 空清单与「用户真的把会话全删了」在类型上完全同形,而后者才是该触发删除的那件事。
 * 同一文件上方那道 TRUSTWORTHINESS GUARD 已经因为一次真实坏读数而存在(它挡的是群组归档),
 * 当时的推理是「agent reaping 不受影响,因为它 key off conversations,而 conversations 我们读到了」——
 * **「读到了」不等于「读全了」**。后端未就绪时(本文件另一处注释记着 lazy ESM 段会让单例读到 undefined)
 * 返回的空数组同样是「读到了」。
 *
 * 判据用本仓自己的定律:**报「0」之前先证明这台仪器读得出非零。**
 * 本进程生命周期内一次都没读出过非空会话清单时,空清单不算阴性读数,不授权按缺席删除;
 * 读出过之后,空清单就是真的空,照常回收(否则用户真删光了会永远收不掉)。
 */
export function emptyInventoryCanAuthorizeReap(input: {
  liveSessionCount: number
  boundAgentCount: number
  everSawNonEmptyInventory: boolean
}): boolean {
  if (input.liveSessionCount > 0) return true
  if (input.boundAgentCount === 0) return true
  return input.everSawNonEmptyInventory
}

function reapLogger() {
  return createLogger('sessionpage/reap')
}

/** 本进程生命周期内是否读出过非空会话清单 —— 空读数的阳性对照。 */
let everSawNonEmptyInventory = false

export async function reconcileSessionpageAgents(deps: SessionpageReapDeps): Promise<SessionpageReapResult> {
  return serialize(() => reconcileLocked(deps))
}

async function reconcileLocked(deps: SessionpageReapDeps): Promise<SessionpageReapResult> {
  const env = deps.env ?? process.env
  const inventory = await deps.getInventory()
  const liveSessions = new Set(inventory.sessionIds)
  const liveProjects = new Set(inventory.projectIds)

  const roster = await listAgents(env, { includeGuests: true })
  // Only records this module provisioned (they carry the conversation binding) are ours to reap. A gugu
  // agent the user made themselves has no binding and must never be touched here.
  // #4277 停放行(别的账号正在驱动这条会话时挪到 parked 格的绑定)同样跟着会话走:会话没了一起收。
  const bound = agentsForOwner(roster, null)
    .map((agent) => ({
      guguUserId: agent.gugu_user_id,
      name: agent.name,
      sessionId: cacheString(agent.cache, SESSION_CACHE_KEY)
        || cacheString(agent.cache, PARKED_SESSION_CACHE_KEY),
      chatId: cacheString(agent.cache, GROUP_CACHE_KEY),
      projectId: cacheString(agent.cache, PROJECT_CACHE_KEY),
      ownerUserId: cacheString(agent.cache, OWNER_CACHE_KEY),
    }))
    .filter((a) => a.sessionId)

  if (liveSessions.size > 0) everSawNonEmptyInventory = true
  const reapAuthorized = emptyInventoryCanAuthorizeReap({
    liveSessionCount: liveSessions.size,
    boundAgentCount: bound.length,
    everSawNonEmptyInventory,
  })
  if (!reapAuthorized) {
    // fail loud 而不是静默跳过:静默跳过会让「从没回收过」和「这轮没东西可收」同形,
    // 而那正是这类缺陷最难查的地方。
    reapLogger().warn(
      {
        boundAgents: bound.length,
        liveSessions: liveSessions.size,
        everSawNonEmptyInventory,
      },
      'session list came back EMPTY while bound agents exist and this process has never read a ' +
        'non-empty inventory — refusing to reap by absence this round (#3969). An empty reading from an ' +
        'instrument never proven able to read non-empty is not evidence for archival.',
    )
  }

  const stale = bound.filter((a) => reapAuthorized && !liveSessions.has(a.sessionId))

  // 开机那一刻 authProvider 往往还没建好(#5025):这一轮读不到令牌,归档留给 main.ts 在归属定下来之后那一轮。
  const auth = await deps.getAuth()

  // Local absence is not a deletion receipt: another profile, a reinstall or a
  // repaired database can all retain a group mapping without its project row.
  // Preserve that mapping and the cloud group; recovery must be an explicit user action.
  const mappings = auth?.userId ? await listProjectGroupIds(auth.userId, env) : []
  const liveProjectChats = new Set(mappings.filter(row => liveProjects.has(row.projectId)).map(row => row.chatId))
  const missingProjects = new Map(mappings.filter(row => !liveProjects.has(row.projectId)).map(row => [row.projectId, row.chatId]))
  for (const agent of bound) {
    if (agent.projectId && agent.chatId && liveProjects.has(agent.projectId)) liveProjectChats.add(agent.chatId)
    if (agent.projectId && agent.chatId && !liveProjects.has(agent.projectId)
      && (!agent.ownerUserId || agent.ownerUserId === auth?.userId)) missingProjects.set(agent.projectId, agent.chatId)
  }
  for (const [projectId, chatId] of missingProjects) {
    if (liveProjectChats.has(chatId)) continue
    const message = `本机缺少项目 ${projectId} 的记录；保留群、历史和原绑定，不按缺席归档。`
    reapLogger().warn({ projectId, chatId }, message)
  }
  if (!stale.length) return { reapedAgents: 0, archivedGroups: 0 }
  if (!auth?.accessToken) {
    throw new Error(`session-page reap: owner not authenticated — ${stale.length} stale agent(s) left in place (retried on next trigger)`)
  }
  const failures: string[] = []
  const archivedGroups = 0
  let reapedAgents = 0
  for (const agent of stale) {
    // Foreign-owner rows stay untouched; their owner reconciles them through the same archival path.
    if (agent.ownerUserId && agent.ownerUserId !== auth.userId) {
      reapLogger().info(
        { agent: agent.guguUserId, name: agent.name, owner: agent.ownerUserId, sessionId: agent.sessionId },
        'session is gone but the agent belongs to another account — left for its owner to reap',
      )
      continue
    }
    try {
      await reapAgent(agent, { env, deps })
      reapedAgents++
      console.log(
        `[sessionpage-reap] reaped agent ${agent.name} (${agent.guguUserId}) — session-page session ${agent.sessionId} is gone`,
      )
    } catch (err) {
      deps.onFailure?.('agent-reconcile', agent.sessionId, err)
      failures.push(`reap agent ${agent.guguUserId}: ${(err as Error).message}`)
    }
  }

  if (failures.length) {
    throw new Error(`session-page reap had ${failures.length} failure(s): ${failures.join(' | ')}`)
  }
  return { reapedAgents, archivedGroups }
}

async function reapAgent(
  agent: {
    guguUserId: string
    name: string
    sessionId: string
    chatId: string
  },
  ctx: {
    env: NodeJS.ProcessEnv
    deps: SessionpageReapDeps
  },
): Promise<void> {
  // 1. Stop routing, then tear down the runtime session. Session-direct rows live in the same
  //    conversation outbox as chat messages; removing the owner stops future reads, while pending
  //    rows remain durable with the retained task history.
  emdashAgentRegistry.unregister(agent.guguUserId)
  await ctx.deps.disposeSession?.(agent.sessionId)

  // Missing task rows never authorize deleting identities, messages or group seats.
  await releaseAgentLocalFootprint({ agentUserId: agent.guguUserId, identityRemoved: false, env: ctx.env })
}
