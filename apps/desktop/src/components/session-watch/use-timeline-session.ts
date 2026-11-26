import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { recoverTimelineRead } from './timeline-read-recovery'
import type {
  LeanPage,
  RecordCursor,
  SettlementResponse,
  SessionpageSessionRespondRequest,
  SessionpageSessionRespondResult,
  TimelineAfterResult,
  TimelineOlderResult,
  TimelineSnapshot,
} from '@gugu/session-core/session-record/contract'
import {
  applyLocalSettlement,
  applySnapshot,
  applyTimelineResult,
  emptyAgentWatchTimeline,
  prependOlder,
  type AgentWatchTimeline,
} from './agent-watch-store'
import { createHeldTurnReader, FOLDED, withWholeTurns } from './folded-pages'
import { settlePendingSends, userMessageIds, type PendingSend } from './pending-sends'
import { loadRetryDelay, LOAD_RETRY_DELAYS_MS } from './record-wait'
import { forgetSessionStream, hydrateCachedTimeline, initialSessionStream, readCachedTimeline, sessionStreamKey, sessionStreams, updateSessionStream, writeCachedTimeline, type AgentWatchPhase, type SessionStreamState, type StreamWrite, type TimelineLink } from './timeline-cache'
import { useSelect } from '@/lib/selectStore'

/** 读写**另一台机器**上一条会话所需的那几问(手机用 sessionpage-rpc.ts 那一组;单测换成假的)。 */
export type SessionpageTimelineClient = {
  /** `lean`: how much of each page to ask for (`folded-pages`); a whole page when absent. */
  fetchSnapshot(deviceId: string, sessionId: string, limit?: number, lean?: LeanPage): Promise<TimelineSnapshot>
  /** `lean` on after / subscribe: the form of the snapshot a reset answer carries (`folded-pages`). */
  fetchAfter(deviceId: string, sessionId: string, cursor: RecordCursor, lean?: LeanPage): Promise<TimelineAfterResult>
  fetchOlder(deviceId: string, sessionId: string, beforeTurnId: string, limit?: number, lean?: LeanPage): Promise<TimelineOlderResult>
  subscribeSession(deviceId: string, sessionId: string, subscriptionId: string, cursor: RecordCursor | null, lean?: LeanPage): Promise<unknown>
  unsubscribeSession(deviceId: string, subscriptionId: string): Promise<unknown>
  subscribeSessionEvents(deviceId: string, subscriptionId: string, onResult: (result: TimelineAfterResult) => void): () => void
  /** A transport that reads incrementally itself can expose a precise read failure. */
  subscribeSessionErrors?(deviceId: string, subscriptionId: string, onError: (error: unknown) => void): () => void
  /** The cached cursor can be reconciled over a request independent of the subscription window. */
  reconcileOnSubscribe?: boolean
  /** 到那台机器的窗口断了 / 又通了。又通 = 那边已拆了这条窗口上的订阅,要重订。 */
  onLinkChange(deviceId: string, cb: (open: boolean) => void): () => void
  sendSessionText(
    deviceId: string,
    sessionId: string,
    text: string,
  ): Promise<unknown>
  cancelSessionTurn(deviceId: string, sessionId: string): Promise<{ cancelled: boolean }>
  respondToSettlement(deviceId: string, input: SessionpageSessionRespondRequest): Promise<SessionpageSessionRespondResult>
  /** 运行时说还在跑的后台命令(`null` = 没报、不筛);老版本电脑没有这条路由会抛。 */
  fetchBackgroundTasks?(deviceId: string, sessionId: string): Promise<{ runningCommandTaskIds: string[] | null }>
  /** 停一个后台任务(命令给 asyncTaskId,子智能体给派它的 tool_use id)。 */
  stopBackgroundTask?(deviceId: string, sessionId: string, stopId: string): Promise<{ stopped: true }>
}

/** 设备接口报的错带 code(跨 bundle 时 instanceof 不可靠,按形状认)。 */
function rpcErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return null
}

/** A new session's first prompt and the client message id its create request gave it. */
export type FirstPrompt = { id: string; text: string; sentAt: number }

export type { AgentWatchPhase } from './timeline-cache'


export type AgentWatchSession = {
  timeline: AgentWatchTimeline
  phase: AgentWatchPhase
  /** 打不开时的原因原文(fail loud,❌ 改写成「失败」)。 */
  /** 读时间线失败。整页级:时间线可能压根没有。 */
  error: string | null
  /** 动作(发消息/回答)失败。时间线是好的,❌ 别说成「打不开时间线」。 */
  actionError: string | null
  /** 还在 loading,且是在等那台机器写下记录的第一行(新会话的常态),不是普通的「正在读取」。 */
  waitingForRecord: boolean
  dismissActionError: () => void
  reload: () => void
  /** 往前翻更早的轮（懒加载）。手里一轮都没有时是空操作。 */
  loadOlder: () => Promise<void>
  /** A row of a folded page came on screen from behind a fold: read its turn whole (`folded-pages`). */
  fillHeld: (itemId: string) => void
  send: (text: string) => Promise<void>
  /** 已按发送、记录里还没回来的那几句(见 pending-sends.ts),按发送先后。回显到了就不在这里了。 */
  pendingSends: readonly PendingSend[]
  respond: (input: SettlementResponse) => Promise<SessionpageSessionRespondResult>
  sending: boolean
  respondingItemId: string | null
  /** 停掉正在飞的一轮(桌面端同一条取消口)。受理即返回;是否真停了看时间线结算。 */
  cancel: () => Promise<void>
  cancelling: boolean
  link: TimelineLink
  /** 最近一次读失败的错误码(太旧 / 会话没了这类要换说法);传输层失败是 null。 */
  errorCode: string | null
}

/**
 * 等本地库最多这么久。
 *
 * 它只是为了不白拉一次整份快照，所以宁可等一小会儿；但本地库卡住（配额、被禁、
 * 另一个标签页占着升级）❌ 不能把「打开会话」拖死 —— 超时就当没有存过，照旧整份拉。
 */
const HYDRATE_BUDGET_MS = 400

const NO_SENDS: readonly PendingSend[] = []
const timelineLog = rendererLogger('agent-watch/timeline')

function newLocalId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is required to mint a sessionpage subscription / pending-send id')
  }
  return randomUUID.call(globalThis.crypto)
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = rpcErrorCode(err)
  return code ? `${message} (${code})` : message
}

/**
 * 打开一台**在线**机器上的一条会话:先快照、再订阅、断线只补缺口。
 *
 * 三条路都汇进同一个 reducer(见 agent-watch-store):
 *   ① 进入时的整份快照
 *   ② 订阅推来的增量
 *   ③ 重连 / 回前台后拿 cursor 调 after 补的那一段
 * ❌ 不为「重连」另写一套合并逻辑 —— 两套合并必然分叉,而分叉的症状是消息重复或缺一段。
 */
export function useTimelineSession(
  client: SessionpageTimelineClient,
  /** 回答者标识,进 `Settlement.resolvedBy`,只用于显示「已在某端回答」(哪一端答的,不是设备 id)。 */
  responderId: string,
  deviceId: string | null,
  sessionId: string | null,
  enabled: boolean,
  /**
   * 刚建的会话:建它时带的那句,机器已受理。挂载时就是一句在路上的发送,记录里那一行到了照常让位。
   * `id` 是建会话请求里给它铸的那个(宿主以它收下首句):乐观那一行、待发行、原生消息是同一个身份(#2296)。
   */
  firstPrompt?: FirstPrompt,
  /** A conversation view reading another machine: ask for pages folded and read a held turn whole on `fillHeld` (`folded-pages`). */
  folded = false,
): AgentWatchSession {
  const lean = folded ? FOLDED : undefined
  /*
   * 会话流 store / 内存里有上次看到的那一份就拿它当**初值**:第一帧就是完整的时间线。❌ 先画一帧空线程、再在 follow 里换上 ——
   * 那一帧(真机几百 ms)里写的是「Nothing in this task yet」,随后整段历史从透明淡入、再跳到底:
   * owner 10-12「进运行中的任务页,一进去就颤两下」。follow 里那次读照旧,换会话时靠它。
   */
  const streamKey = useMemo(() => (deviceId && sessionId ? { deviceId, sessionId } : null), [deviceId, sessionId])
  const followed = useSelect(sessionStreams, (map) => (streamKey ? map[sessionStreamKey(streamKey)] : undefined), Object.is)
  const initial = useMemo(() => initialSessionStream(streamKey), [streamKey])
  const { timeline, phase, error, link, errorCode, waitingForRecord } = followed ?? initial
  const { setTimeline } = useMemo(() => streamWriters(streamKey), [streamKey])
  // 动作失败与读失败分开存:两者的标题、位置、能做的补救都不是一回事 ——
  // 发送失败时时间线好端端在那儿,套上「打不开时间线 + 重新读取」是在骗人。
  const [actionError, setActionError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // 乐观发送按会话存(`key`):换了会话,上一条会话的那几句在渲染时就不认,❌ 靠 effect 事后清 —— 那样会在新会话里闪一帧。
  const [pendingState, setPendingState] = useState<{ key: string; sends: readonly PendingSend[] }>(() => (firstPrompt
    ? { key: `${deviceId ?? ''}/${sessionId ?? ''}`, sends: [{ id: firstPrompt.id, text: firstPrompt.text, sentAt: firstPrompt.sentAt, baseline: new Set(), accepted: true }] }
    : { key: '', sends: NO_SENDS }))
  const [respondingItemId, setRespondingItemId] = useState<string | null>(null)

  // 翻页要读「此刻最早那一轮」,而 loadOlder 被界面按钮以闭包形式握着 ——
  // 依赖 timeline 会让每次时间线更新都换一个新函数,读 ref 才拿得到当下那份。
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline
  const olderIdentity = JSON.stringify([deviceId, sessionId, enabled])
  const olderIdentityRef = useRef(olderIdentity)
  olderIdentityRef.current = olderIdentity
  const olderRequest = useRef<{ identity: string; generation: number; promise: Promise<void> } | null>(null)
  const olderGeneration = useRef(0)
  useEffect(() => () => { olderGeneration.current++ }, [client, deviceId, sessionId, enabled])

  const reload = useCallback(() => {
    if (deviceId && sessionId) restartSessionFollow({ client, deviceId, sessionId, enabled, lean })
  }, [client, deviceId, sessionId, enabled, lean])

  useEffect(() => {
    if (!deviceId || !sessionId) return
    return attachSessionFollow({ client, deviceId, sessionId, enabled, lean }, () => { olderGeneration.current++ })
  }, [client, deviceId, sessionId, enabled, lean])

  // An older page can report a different epoch while a history request is in flight.
  useEffect(() => {
    if (timeline.needsSnapshot && deviceId && sessionId) restartSessionFollow({ client, deviceId, sessionId, enabled, lean }, true)
  }, [timeline.needsSnapshot, client, deviceId, sessionId, enabled, lean])

  /*
   * 边看边存。**防抖**:一条流式消息每秒推好几次,每次都整份序列化 + 写库
   * 会把这点开销叠成卡顿 —— 那正是这一批要消灭的那种卡。
   * 页面走掉时的最后一次存在上面那个 cleanup 里(不依赖这个定时器还没烧完)。
   */
  useEffect(() => {
    if (!deviceId || !sessionId) return
    if (!timeline.cursor || timeline.turns.length === 0) return
    const timer = setTimeout(() => {
      writeCachedTimeline({ deviceId, sessionId }, timeline)
    }, 1_500)
    return () => clearTimeout(timer)
  }, [client, deviceId, sessionId, timeline])

  /**
   * 懒加载更早的轮。基准是手里**最早那一轮的 id**（❌ 不是下标：两次请求之间那一轮可能
   * 被分叉掉，下标会指到另一轮上去）。翻不动了由宿主报 hasOlder=false，界面据此收起入口。
   */
  const loadOlder = useCallback(async () => {
    if (!deviceId || !sessionId || !enabled) return
    const pinned = timelineRef.current
    const oldest = pinned.turns[0]
    if (!pinned.hasOlder || !oldest) return
    const generation = olderGeneration.current
    const identity = olderIdentityRef.current
    if (olderRequest.current?.identity === identity && olderRequest.current.generation === generation) return olderRequest.current.promise
    const reading = (async () => {
      try {
        const older = await client.fetchOlder(deviceId, sessionId, oldest.id, undefined, lean)
        if (generation !== olderGeneration.current || identity !== olderIdentityRef.current) return
        setTimeline(current => {
          if (generation !== olderGeneration.current || identity !== olderIdentityRef.current) return current
          // A reset, or an After that dropped the oldest turn, owns the page. An After that only moved the tail does not:
          // every delta of a streaming reply is one, and held to the same `seq` no older page could land while an agent was working.
          if (current.cursor?.epoch !== pinned.cursor?.epoch || current.turns[0]?.id !== oldest.id) return current
          return prependOlder(current, older)
        })
      } catch (err) {
        if (generation === olderGeneration.current && identity === olderIdentityRef.current) setActionError(describe(err))
      }
    })()
    olderRequest.current = { identity, generation, promise: reading }
    try { await reading } finally { if (olderRequest.current?.promise === reading) olderRequest.current = null }
  }, [client, deviceId, sessionId, enabled, lean, setTimeline])

  /*
   * 回显到了的那几句在**渲染时**就让位(派生,❌ 等下面那个 effect:那样记录里那一行与乐观那一行
   * 会同屏一帧);effect 只负责把 state 收成同一份,免得已认领的留在 state 里被后来的记录再认一次。
   */
  const pendingKey = `${deviceId ?? ''}/${sessionId ?? ''}`
  const ownSends = pendingState.key === pendingKey ? pendingState.sends : NO_SENDS
  const pendingSends = useMemo(
    () => settlePendingSends(ownSends, timeline.turns, timeline.queuedPrompts),
    [ownSends, timeline.turns, timeline.queuedPrompts],
  )
  useEffect(() => {
    // 函数式、且只在 state 还是算它的那一份时才收:这一帧与 effect 之间又按了一次发送的话,
    // 直接写回会把新加的那一句一起抹掉。
    if (pendingSends === ownSends) return
    setPendingState((current) => (current.key === pendingKey && current.sends === ownSends ? { key: pendingKey, sends: pendingSends } : current))
  }, [pendingKey, pendingSends, ownSends])

  const send = useCallback(async (text: string) => {
    if (!deviceId || !sessionId) return
    const body = text.trim()
    if (!body) return
    // 按下发送就画出来(pending-sends.ts 说了为什么):那台机器上的 agent 没在跑时,这次往返要先等它起来。
    // 还没和机器对过账就不画(SessionFollow.synced):认不准回显的乐观行宁可不要,退回等记录回来。
    const key = `${deviceId}/${sessionId}`
    const pendingId = deviceId && sessionId && follows.get(sessionStreamKey({ deviceId, sessionId }))?.synced ? `pending:${newLocalId()}` : null
    // 受理/失败回来时人可能已经换到别的会话、在那边又发了一句:只动还是这条会话的那一份,❌ 把别人的清掉。
    const update = (next: (sends: readonly PendingSend[]) => readonly PendingSend[]) =>
      setPendingState((current) => (current.key === key ? { key, sends: next(current.sends) } : current))
    if (pendingId) {
      const added: PendingSend = { id: pendingId, text: body, baseline: userMessageIds(timelineRef.current.turns, timelineRef.current.queuedPrompts), accepted: false }
      setPendingState((current) => ({ key, sends: [...(current.key === key ? current.sends : NO_SENDS), added] }))
    }
    setSending(true)
    setActionError(null)
    try {
      await client.sendSessionText(deviceId, sessionId, body)
      if (pendingId) update((sends) => sends.map((p) => (p.id === pendingId ? { ...p, accepted: true } : p)))
    } catch (err) {
      // ❌ 不排队假装已发出(product spec):发不出去就说发不出去 —— 乐观那一行一起撤掉。
      // 记在 actionError 上 —— 这是**发送**失败,时间线没坏。
      if (pendingId) update((sends) => sends.filter((p) => p.id !== pendingId))
      setActionError(describe(err))
      throw err
    } finally {
      setSending(false)
    }
  }, [client, deviceId, sessionId])

  const [cancelling, setCancelling] = useState(false)
  const cancel = useCallback(async () => {
    if (!deviceId || !sessionId) return
    setCancelling(true)
    setActionError(null)
    try {
      await client.cancelSessionTurn(deviceId, sessionId)
    } catch (err) {
      // 停不下来就说停不下来,❌ 把按钮按灰当作已停:是否真停了以时间线结算为准。
      setActionError(describe(err))
    } finally {
      setCancelling(false)
    }
  }, [client, deviceId, sessionId])

  const respond = useCallback(async (input: SettlementResponse) => {
    if (!deviceId || !sessionId) throw new Error('No session is available to answer this question')
    setRespondingItemId(input.itemId)
    setActionError(null)
    try {
      const result = await client.respondToSettlement(deviceId, { ...input, conversationId: sessionId, by: responderId })
      // 抢跑成功与失败都带回**那条权威结算**:失败时它是别人先答下的那条,
      // 端上据此显示「已在某端回答」。所以这里不分支,直接并进去。
      setTimeline((current) => applyLocalSettlement(current, result.settlement))
      return result
    } catch (err) {
      setActionError(describe(err))
      throw err
    } finally {
      setRespondingItemId(null)
    }
  }, [client, responderId, deviceId, sessionId, setTimeline])

  const dismissActionError = useCallback(() => setActionError(null), [])
  // A row of a turn this page was sent folded came on screen from behind a fold: read that turn whole (`folded-pages`).
  const fillHeld = useMemo(() => !deviceId || !sessionId ? () => undefined : createHeldTurnReader({
    pages: {
      snapshot: (limit) => client.fetchSnapshot(deviceId, sessionId, limit),
      older: (beforeTurnId, limit) => client.fetchOlder(deviceId, sessionId, beforeTurnId, limit),
    },
    turns: () => timelineRef.current.turns,
    land: (whole) => setTimeline((current) => ({ ...current, turns: withWholeTurns(current.turns, whole) })),
    failed: (err) => setActionError(describe(err)),
  }), [client, deviceId, sessionId, setTimeline])
  return {
    timeline, phase, error, actionError, dismissActionError, waitingForRecord,
    reload, loadOlder, fillHeld, send, pendingSends, respond, sending, respondingItemId, cancel, cancelling,
    link, errorCode,
  }
}

/** `lean`: the first page following a session sets it for the stream; folded pages keep what reply progress and question cards read. */
/** What following a session's stream asks of its machine: pages, the subscription and its pushes, the link. */
export type TimelineStreamClient = Pick<SessionpageTimelineClient, 'fetchSnapshot' | 'fetchAfter' | 'subscribeSession' | 'unsubscribeSession'
  | 'subscribeSessionEvents' | 'subscribeSessionErrors' | 'onLinkChange' | 'reconcileOnSubscribe'>
export type FollowParams = { client: TimelineStreamClient; deviceId: string; sessionId: string; enabled: boolean; lean?: LeanPage }
/** One follow of a session's host stream, shared by every page showing it (ref-counted); writes `sessionStreams`. */
type SessionFollow = {
  params: FollowParams
  followers: number
  stop: () => void
  // cursor 放在 follow 上:补缺口发生在事件回调/定时器里,要读当下那一份。
  cursor: RecordCursor | null
  // 快照落地前不收增量:此时手里还没有可续的那一份,收了只会得到一段悬空的尾巴。
  ready: boolean
  // 手里这份**已经和那台机器对过一次账**(整份快照落地,或本地底稿补完差量;记录还没写出来也算 —— 那时确实是空的)。
  // 乐观发送靠「发送那一刻已有哪些行」认回显,底稿还没对账时这份清单不全:之后补进来的整段都会被当成新行。
  synced: boolean
  olderResets: Set<() => void>
  resetOlder: () => void
  /** Ask now for what came after the cursor (a revert, read at once); settles when it has landed or failed. */
  catchUp: () => Promise<void>
}
// One follow per session stream (the entry it writes): ❌ per client object or `enabled`.
const follows = new Map<string, SessionFollow>()

function streamWriters(streamKey: { deviceId: string; sessionId: string } | null) {
  const write = (fields: StreamWrite<SessionStreamState>) => { if (streamKey) updateSessionStream(streamKey, fields) }
  return { write, setTimeline: (change: (current: AgentWatchTimeline) => AgentWatchTimeline) => write((current) => ({ timeline: change(current.timeline) })) }
}

/** Follow a session's host stream from one more page; returns the detach. `onOlderReset` hears a reset / resolution. */
function attachSessionFollow(params: FollowParams, onOlderReset: () => void): () => void {
  const key = sessionStreamKey(params)
  let follow = follows.get(key)
  if (!follow) {
    const created: SessionFollow = {
      params, followers: 0, stop: () => undefined, cursor: null, ready: false, synced: false, olderResets: new Set(),
      resetOlder: () => { for (const reset of [...created.olderResets]) reset() }, catchUp: async () => undefined,
    }
    follows.set(key, created)
    created.stop = runSessionFollow(created)
    follow = created
  } else if (params.enabled && !follow.params.enabled) {
    // A page that can reach the machine joins one that could not: the follow reads now (❌ stays on the cached picture).
    follow.params = params
    restartSessionFollow(params)
  }
  const active = follow
  active.followers += 1
  active.olderResets.add(onOlderReset)
  return () => {
    active.olderResets.delete(onOlderReset)
    if (--active.followers > 0) return
    follows.delete(key)
    active.stop()
    // Its link, phase and error were this follow's (❌ the next open's first frame).
    forgetSessionStream(params)
  }
}

/**
 * A reader outside React following the same stream the timeline page fills (the desktop session page of a task on
 * another machine): one copy of a session's timeline in this window, whoever shows it. A reader that comes after
 * another continues from the copy that one held (subscribe from its cursor, read what came after: see `loadSnapshot`),
 * ❌ reads the first page again. `onOlderReset` hears a reset / resolution (an older page asked before it is void).
 */
export function followSessionStream(params: FollowParams, onOlderReset: () => void) {
  const detach = attachSessionFollow(params, onOlderReset)
  return {
    detach,
    setTimeline: streamWriters(params).setTimeline,
    catchUp: () => follows.get(sessionStreamKey(params))?.catchUp() ?? Promise.resolve(),
  }
}

function restartSessionFollow(params: FollowParams, forceSnapshot = false): void {
  const follow = follows.get(sessionStreamKey(params))
  if (!follow) return
  follow.stop()
  follow.stop = runSessionFollow(follow, forceSnapshot)
}

function runSessionFollow(follow: SessionFollow, forceSnapshot = false): () => void {
  const { client, deviceId, sessionId, enabled, lean } = follow.params
  const cacheKey = { deviceId, sessionId }
  const key = sessionStreamKey(cacheKey)
  const { write, setTimeline } = streamWriters(cacheKey)
  const heldTimeline = () => sessionStreams.get()[key]?.timeline
  let cancelled = false
  let needsFreshSnapshot = forceSnapshot
  let restarting = false
  const retiredEpochs = new Set<string>()
  // Finish the current callback before tearing down its subscription. A gap takes priority over a reconnect.
  const reload = () => {
    if (restarting) return
    restarting = true
    queueMicrotask(() => {
      if (!cancelled && follows.get(key) === follow) restartSessionFollow(follow.params, needsFreshSnapshot)
    })
  }
  const applyResult = (result: TimelineAfterResult): boolean => {
    const current = heldTimeline() ?? emptyAgentWatchTimeline()
    const received = result.ok ? result.batch.cursor : result.snapshot.cursor
    const next = retiredEpochs.has(received.epoch) ? current : applyTimelineResult(current, result)
    if (next === current) {
      timelineLog.debug({ epoch: received.epoch, heldEpoch: current.cursor?.epoch, heldSeq: current.cursor?.seq,
        fromSeq: result.ok ? result.batch.from : undefined, receivedSeq: received.seq }, 'Discarded stale timeline result')
      return false
    }
    if (next.needsSnapshot) {
      needsFreshSnapshot = true
      reload()
      return false
    }
    if (!result.ok) {
      if (current.cursor && current.cursor.epoch !== received.epoch) retiredEpochs.add(current.cursor.epoch)
      follow.resetOlder()
      timelineLog.info({ reason: result.reset }, 'Timeline snapshot reset')
    }
    follow.cursor = next.cursor
    setTimeline(() => next)
    return true
  }
  if (!enabled) {
    const cached = heldTimeline() ?? readCachedTimeline(cacheKey)
    write({ error: null, errorCode: null, link: 'lost', timeline: cached ?? emptyAgentWatchTimeline() })
    if (!cached) void hydrateCachedTimeline(cacheKey).then((stored) => { if (!cancelled && stored) write({ timeline: stored }) })
    return () => { cancelled = true }
  }
  const recoveryAbort = new AbortController()
  const subscriptionId = newLocalId()
  follow.ready = false
  follow.synced = false
  follow.cursor = null
  /*
   * 先把**上次看到的那一份**画出来(本地底稿),再去对账。
   * owner 2026-09-08 拍板要这一层:以前每次进页都得等机器把整份快照送过来才有东西看,
   * 于是首屏永远是「正在读取时间线…」。底稿不是事实源 —— 它只活到下面第一次对账为止。
   */
  const cached = heldTimeline() ?? readCachedTimeline(cacheKey)
  if (!forceSnapshot && cached?.cursor) {
    follow.cursor = cached.cursor
    follow.ready = true
  }
  write({ error: null, link: 'connecting', ...(cached ? { timeline: cached, phase: 'ready' } : { phase: 'loading' }) })

  /*
   * 补缺口失败不清空已有的那一份:屏幕上那段仍然是真的,只是没有更新。会自己好的读失败按既有退避自动补几次，
   * 耗尽才交统一出口，期间不把重试按钮留给用户；窗口重开、回前台也能重新驱动。
   * 失败耗尽后仍如实报原文，补上了就收回这一条 —— 别的路报的错(比如订阅没订上)不归这里管。
   * 补上一次就算和那台机器对过账了(follow.synced)。
   */
  let catchUpReported = false
  let catchUpRunning: Promise<void> | null = null
  const catchUp = (): Promise<void> => {
    const cursor = follow.cursor
    if (catchUpRunning) return catchUpRunning
    if (cancelled || !follow.ready || !cursor) return Promise.resolve()
    catchUpRunning = recoverTimelineRead(() => client.fetchAfter(deviceId, sessionId, cursor, lean), recoveryAbort.signal)
      .then((result) => {
        if (cancelled || restarting || follow.cursor?.epoch !== cursor.epoch) return
        // A concurrent push can already have advanced beyond a reset response to an older request.
        if (!result.ok && result.snapshot.cursor.epoch === cursor.epoch
          && follow.cursor.seq > cursor.seq && result.snapshot.cursor.seq < follow.cursor.seq) return
        if (!applyResult(result)) return
        write(catchUpReported ? { link: 'ok', error: null, errorCode: null } : { link: 'ok' })
        catchUpReported = false
        follow.synced = true
      })
      .catch((err) => {
        if (cancelled) return
        catchUpReported = true
        write({ link: 'lost', error: messageForUser(err), errorCode: rpcErrorCode(err) })
      }).finally(() => { catchUpRunning = null })
    return catchUpRunning
  }
  follow.catchUp = catchUp

  /*
   * 内存里没有 ⇒ 这是**冷启动后第一次**进这条会话，去本地库里捞上次那份。
   *
   * 下面的 `loadSnapshot` 会先等这一步：装上了就只订阅 + 补差量，一次整份快照都不用拉。
   * ❌ 不能不等就先拉快照 —— 那样"存了一份在本地"就只省下第一帧的空白，
   * 该请求的照样请求了一遍，而 owner 要的正是**不要每次都重新去请求**。
   * ⚠️ 但也不能无限等：本地库卡住（配额、被禁、另一个标签页占着升级）不该把打开会话拖死，
   * 所以给它一个上限，超时就当没有存档，照旧整份拉。
   */
  const hydrated: Promise<void> = forceSnapshot || cached
    ? Promise.resolve()
    : Promise.race([
        hydrateCachedTimeline(cacheKey),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), HYDRATE_BUDGET_MS)),
      ]).then((stored) => {
        if (cancelled || follow.ready || !stored) return
        follow.cursor = stored.cursor
        follow.ready = stored.cursor !== null
        write({ timeline: stored, phase: 'ready' })
      })

  // 先挂监听再发 subscribe:反过来的话,宿主在应答与挂监听之间推的那一批没人收。
  const stopEvents = client.subscribeSessionEvents(deviceId, subscriptionId, (result) => {
    if (cancelled || restarting || !follow.ready || !applyResult(result)) return
    follow.synced = true
    if (catchUpReported) {
      catchUpReported = false
      write({ link: 'ok', error: null, errorCode: null })
    }
  })
  const stopErrors = client.subscribeSessionErrors?.(deviceId, subscriptionId, () => {
    if (cancelled) return
    write({ link: 'lost' })
    void catchUp()
  })
  // 窗口断了:标断开;又通了:那台机器已经拆了这条订阅(订阅跟着窗口生灭),整个重来 —— 手里有游标就只重订 + 补差量。
  const stopLink = client.onLinkChange(deviceId, (open) => {
    if (cancelled) return
    if (open) reload()
    else write({ link: 'lost' })
  })

  const onVisible = () => {
    if (document.visibilityState === 'visible') void catchUp()
  }
  document.addEventListener('visibilitychange', onVisible)

  const startedAt = Date.now()
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  write({ waitingForRecord: false })

  const loadSnapshot = async (): Promise<void> => {
    try {
      await hydrated
      if (cancelled) return
      if (follow.ready && follow.cursor) {
        const cursor = follow.cursor
        // A cached phone open reconciles once even if the subscription push or its ACK is delayed.
        if (attempt === 0 && client.reconcileOnSubscribe) void catchUp()
        await client.subscribeSession(deviceId, sessionId, subscriptionId, cursor, lean)
        if (cancelled || restarting) return
        if (!catchUpReported) write({ waitingForRecord: false, error: null, errorCode: null, link: 'ok' })
        attempt = 0
        if (!client.reconcileOnSubscribe) follow.synced = true
        return
      }
      const snapshot = await client.fetchSnapshot(deviceId, sessionId, undefined, lean)
      if (cancelled) return
      follow.resetOlder()
      needsFreshSnapshot = false
      follow.cursor = snapshot.cursor
      follow.ready = true
      follow.synced = true
      setTimeline((current) => applySnapshot(current, snapshot))
      write({ waitingForRecord: false, error: null, phase: 'ready' })
      await client.subscribeSession(deviceId, sessionId, subscriptionId, snapshot.cursor, lean)
      if (cancelled) return
      attempt = 0
      write({ errorCode: null, link: 'ok' })
    } catch (err) {
      if (cancelled) return
      const code = rpcErrorCode(err)
      attempt += 1
      /*
       * ⚠️ 会自己好的失败**自己再试一次**,期间界面停在普通加载态 ——
       * owner 2026-09-08:「不应该是先报一个红色的报错、等我刷新之后才显示出来」。
       * 判据在 record-wait.ts(纯函数),三类各有一条会红的用例。
       */
      const delay = follow.ready ? LOAD_RETRY_DELAYS_MS[attempt - 1] ?? null
        : loadRetryDelay({ code, attempt, elapsedMs: Date.now() - startedAt })
      if (delay !== null) {
        // That machine did not answer: still tried again, but the page can say so meanwhile (link), ❌ a silent spinner.
        if (code === 'timeout') write({ link: 'lost' })
        // 记录还没写出来:留在 loading,过一会儿再读;❌ 不报红。
        write({ waitingForRecord: code === 'record_not_found' })
        if (code === 'record_not_found') follow.synced = true
        retryTimer = setTimeout(() => { void loadSnapshot() }, delay)
        return
      }
      write({ waitingForRecord: false, error: messageForUser(err), errorCode: code, link: 'lost', phase: follow.ready ? 'ready' : 'error' })
    }
  }
  void loadSnapshot()

  return () => {
    cancelled = true
    recoveryAbort.abort()
    if (retryTimer) clearTimeout(retryTimer)
    stopLink()
    follow.ready = false
    document.removeEventListener('visibilitychange', onVisible)
    stopEvents()
    stopErrors?.()
    // 走之前把手里这份存下来:下次进来第一帧就有东西。
    const current = heldTimeline()
    if (current) writeCachedTimeline(cacheKey, current)
    // 退订是尽力而为:页面已经走了,退订失败只会让宿主多推一会儿给没人听的 subscriptionId。
    void client.unsubscribeSession(deviceId, subscriptionId).catch(() => undefined)
  }
}
