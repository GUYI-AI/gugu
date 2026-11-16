import {
  CloudComputerError,
  CloudComputerWakeError,
  CLOUD_COMPUTER_WAKE_TIMEOUT_MS,
  cloudComputerFailureKind,
  cloudComputerOverdue,
  cloudComputerPresence,
  isCloudComputerNotOpen,
  wakeCloudComputerUntilOnline,
  type CloudComputerFailureKind,
  type CloudComputerProvisionInput,
  type CloudComputerWakeInput,
  type CloudComputerSnapshot,
} from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import { rendererCloudComputerClient } from './cloudComputerClient'
import { rendererLogger } from './log'
import { replica, useReplica, type Reading } from './replica'
import { createSelectStore, useSelect } from './selectStore'
import { observeRendererSession } from './sessionPublication'
import { anySignal } from '@gugu/core/shared/anySignal'
import { readCachedDevices } from '../store/devicesCache'

/**
 * #7199 这个账号的云电脑此刻怎样(@@@client-state-model, replica `cloudComputer`):管家的 /state 是唯一事实源;库里的在线与否
 * 只用来判「醒了的那台 server 上线没有」。读数随账号走(换号、登出由 replica 丢掉),跨重启留一份(冷开云电脑那一行不先画成离线)。
 * 什么时候再问:挂着的界面按值定的间隔(开通 / 唤醒途中 3 秒,有一台时 30 秒,窗口在后台不问)、回到前台、设备行里牵动它的变动
 * (DevicesProvider)、这里的动作之后。这里放模型、动作和纯函数。
 */
const log = rendererLogger('cloud-computer')

/** `available: false` = 拿不到管家地址,或那扇门说「环境未配置可选云电脑服务」(503 not_open):这个功能不显示。 */
export type CloudComputerState = { available: false } | { available: true; snapshot: CloudComputerSnapshot }

/** 管家说出错时那句原因只进日志(界面说「云电脑那边出了问题」);同一句只记一次。 */
let loggedSnapshotError: string | null = null

function noteSnapshotError(snapshot: CloudComputerSnapshot): void {
  const failed = snapshot.state === 'error' ? snapshot.error ?? 'error without reason' : null
  if (failed && failed !== loggedSnapshotError) log.warn({ reason: failed, deviceId: snapshot.deviceId }, 'cloud computer reported an error')
  loggedSnapshotError = failed
}

/**
 * /state asked (`issued`) and the last answer put in outside a read (`applied`: the wake loop, `destroy`). A read asked
 * before that answer is older and ❌ lands over it (review E-2: a stale `asleep` would also slow the polling to 30 s).
 */
let issued = 0
let applied = 0

function putAnswer(entry: { set(value: CloudComputerState): void }, value: CloudComputerState): void {
  applied = ++issued
  entry.set(value)
}

/** 问一次管家。没配地址 / 门说「未配置」= 不显示(一个真值);别的没问到 = 读数是错误(界面说读不到,`cloudFailureOf`)。 */
async function readCloudComputer(): Promise<CloudComputerState> {
  const client = rendererCloudComputerClient()
  if (!client) return { available: false }
  const mine = ++issued
  try {
    const snapshot = await client.state()
    const shown = cloudComputer.peek()
    if (mine < applied && shown.state === 'value') return shown.value
    noteSnapshotError(snapshot)
    return { available: true, snapshot }
  } catch (error) {
    // 门说「环境未配置可选云电脑服务」:整块不显示(❌ 给所有人报「读不到云电脑的状态」);配上以后再问到就出现。
    if (isCloudComputerNotOpen(error)) {
      log.info({ code: 'not_open' }, 'cloud computer manager is not configured on this backend')
      return { available: false }
    }
    log.warn({ err: String((error as Error)?.message ?? error) }, 'cloud computer state failed')
    throw error
  }
}

/** 开通 / 唤醒途中多久问一次管家。 */
export const CLOUD_COMPUTER_FAST_POLL_MS = 3_000

/**
 * 有一台云电脑、不在开通 / 唤醒途中时多久问一次管家。它睡下、被别处叫醒(私聊、已安排到点),库里那一行的在线与否
 * 要等心跳超时(实测约 2 分钟)才翻 —— 在不在以管家为准,❌ 等那一行。没有云电脑 = null(❌ 白问)。
 */
export const CLOUD_COMPUTER_WATCH_MS = 30_000

export function cloudComputerWatchMs(snapshot: CloudComputerSnapshot | null): number | null {
  if (!snapshot?.deviceId) return null
  return snapshot.state === 'awake' || snapshot.state === 'asleep' ? CLOUD_COMPUTER_WATCH_MS : null
}

/** 开通 / 唤醒途中多久问一次管家;不在途中 = null(那时由 cloudComputerWatchMs 慢慢问)。 */
export function cloudComputerPollMs(snapshot: CloudComputerSnapshot | null, devices: readonly Device[], now: number = Date.now()): number | null {
  if (!snapshot) return null
  if (snapshot.state === 'provisioning') return CLOUD_COMPUTER_FAST_POLL_MS
  // 正在醒:管家自己会在时限内翻成醒了或出错;它卡在这一格太久就不再每 3 秒问(回到前台、设备行变动照样问)。
  if (snapshot.state === 'waking') return cloudComputerOverdue(snapshot, now, 2 * CLOUD_COMPUTER_WAKE_TIMEOUT_MS) ? null : CLOUD_COMPUTER_FAST_POLL_MS
  if (snapshot.state === 'awake') {
    const device = snapshot.deviceId ? devices.find((d) => d.device_id === snapshot.deviceId) : undefined
    // 管家说醒了、那台 server 还没在库里上线:接着看,直到它上线;过了叫醒时限就不等了(那一行照离线说)。
    if (!device?.is_online && !cloudComputerOverdue(snapshot, now)) return CLOUD_COMPUTER_FAST_POLL_MS
  }
  return null
}

/** 挂着的界面多久再问一次,按此刻读到的值定;设备行(「醒了的那台上线没有」)只为定间隔取一刻,❌ 画。 */
export function cloudComputerRefreshMs(value: CloudComputerState | undefined): number | false {
  if (!value?.available) return false
  return cloudComputerPollMs(value.snapshot, readCachedDevices()) ?? cloudComputerWatchMs(value.snapshot) ?? false
}

export const cloudComputer = replica({
  name: 'cloudComputer',
  scope: 'account',
  read: (_owner: string): Promise<CloudComputerState> => readCloudComputer(),
  refreshOnFocus: true,
  refreshEvery: cloudComputerRefreshMs,
  // `{available, snapshot}`: a fixed shape of a state, a device id, an error line and a time, ~300 B.
  persist: { maxBytes: 1024, maxEntries: 1 },
})

export function useCloudComputer(): Reading<CloudComputerState> {
  return useReplica(cloudComputer, [])
}

/** For logic outside React (a link's reachability). */
export function subscribeCloudComputer(listener: () => void): () => void {
  return cloudComputer.subscribe([], () => listener())
}

/** 读到的那份管家快照;还没读到、读不到、或没有云电脑这项服务 = null(调用方据此不补「收回着 / 醒着」)。 */
export function cloudSnapshotOf(reading: Reading<CloudComputerState>): CloudComputerSnapshot | null {
  return reading.state === 'value' && reading.value.available ? reading.value.snapshot : null
}

/** 最近一次问管家没问到是哪一类(问到了 = null;原文进日志)。 */
export function cloudFailureOf(reading: Reading<CloudComputerState>): CloudComputerFailureKind | null {
  if (reading.state === 'error') return cloudComputerFailureKind(reading.error)
  if (reading.state === 'value' && reading.error) return cloudComputerFailureKind(reading.error)
  return null
}

/** Feature visibility is not readiness: an unread or failed status cannot enable cloud setup. */
export function canSetUpCloudAssistant(reading: Reading<CloudComputerState>): boolean {
  return reading.state === 'value' && reading.value.available && reading.error === null
}

/**
 * 叫醒被管家拒了(积分用完 / 会员到期 / 没有这项权益)的那几台:它收回着、却醒不来 —— 它上面的 agent ❌ 当「收回着、有事自己醒」
 * 不画状态,照读数说不在线并说原因(拒了的时候管家的 /state 仍是 asleep)。这是叫醒这条命令的结果,按设备记;只在管家快照
 * 仍是那台 asleep 时算数(`refusedDeviceIdOf`),那台下一次叫醒成功就去掉。内容属于这个账号。
 */
export const wakeRefusals = createSelectStore<Readonly<Record<string, CloudComputerFailureKind>>>({})

function putRefusals(next: Readonly<Record<string, CloudComputerFailureKind>>): void {
  wakeRefusals.publish(next)
  wakeRefusals.notify()
}

/** 被拒、而管家此刻仍说那台收回着:那台的 id;否则 null。 */
export function refusedDeviceIdOf(refusals: Readonly<Record<string, CloudComputerFailureKind>>, snapshot: CloudComputerSnapshot | null): string | null {
  const deviceId = snapshot?.state === 'asleep' ? snapshot.deviceId : null
  return deviceId && refusals[deviceId] ? deviceId : null
}

export function useWakeRefusal(snapshot: CloudComputerSnapshot | null): { deviceId: string; kind: CloudComputerFailureKind } | null {
  const refusals = useSelect(wakeRefusals, (value) => value)
  const deviceId = refusedDeviceIdOf(refusals, snapshot)
  return deviceId ? { deviceId, kind: refusals[deviceId]! } : null
}

/** 换账号时停掉在途的叫醒(❌ 拿新账号的 /state 接着等旧账号的那台)。 */
let wakeAbort = new AbortController()
type ConnectionWake = { promise: Promise<void>; abort: AbortController; users: number; settled: boolean }
const connectionWakes = new Map<string, ConnectionWake>()
let signedInAs: string | null = null

/** 只在真换了人、或真退出登录时清(冷启动、刷新令牌时会话短暂缺席,那一下 ❌ 作废在途的叫醒) —— 和 replica 的账号同一条规则。 */
export function followCloudComputerAccount(event: string, userId: string | null): void {
  if (userId ? userId === signedInAs : event !== 'SIGNED_OUT') return
  const switched = signedInAs !== null || !userId
  signedInAs = userId
  if (!switched) return
  wakeAbort.abort()
  wakeAbort = new AbortController()
  connectionWakes.clear()
  wakeInFlight.clear()
  putRefusals({})
}

observeRendererSession(({ event, session }) => followCloudComputerAccount(event, session?.user.id ?? null))

/** 管家拒绝叫醒的那几类:权益 / 积分的事,再叫也一样,直到人去续费 / 充值。 */
const WAKE_REFUSALS: ReadonlySet<CloudComputerFailureKind> = new Set(['plan_required', 'credits_exhausted', 'membership_expired'])

/** 叫醒没成:是被拒就记下是哪台、为什么(界面据此照实说不在线 + 原因);别的失败不记。原样抛回。 */
function noteWakeFailure(error: unknown, deviceId: string | null): never {
  const kind = cloudComputerFailureKind(error)
  if (WAKE_REFUSALS.has(kind) && deviceId) putRefusals({ ...wakeRefusals.get(), [deviceId]: kind })
  throw error
}

function forgetRefusal(deviceId: string | null): void {
  if (!deviceId || !wakeRefusals.get()[deviceId]) return
  const { [deviceId]: _gone, ...rest } = wakeRefusals.get()
  putRefusals(rest)
}

function requireClient() {
  const client = rendererCloudComputerClient()
  if (!client) throw new CloudComputerError(0, 'unavailable', 'cloud computer manager URL is not configured')
  return client
}

/**
 * 现问一次管家(打开它上面的会话、开私聊、搬家等它之前),返回此刻的快照;没有这项服务 = null,问不到就抛。
 * 已经在路上的那一次就等它(`fresh` 是 0:没有在路上的就现问)。答案落进读数,画着它的界面一起更新。
 */
export async function readCloudSnapshotNow(): Promise<CloudComputerSnapshot | null> {
  const value = await cloudComputer.fetch()
  return value.available ? value.snapshot : null
}

/** 此刻已知的那台云电脑的设备 id(一刻的决定,❌ 画);没读到 / 没有 = null。 */
export function knownCloudDeviceId(): string | null {
  return cloudSnapshotOf(cloudComputer.peek())?.deviceId ?? null
}

/** 开一台。202 之后进度靠 /state;这里先问一次,让界面立刻进「正在开通」。 */
export async function provisionCloudComputer(input?: CloudComputerProvisionInput): Promise<void> {
  await requireClient().provision(input)
  await cloudComputer.refresh()
}

/**
 * 正在叫的那几次:连着敲字时同一次叫醒不重复发(❌ 每个字一个 POST /wake)。
 * 按用途分开记:搬家读旧家的那一叫(`purpose: 'move_out'`,会员到期也放行)不能被一次普通的叫醒顶掉 —— 到期后普通叫醒会被拒。
 */
const wakeInFlight = new Map<string, Promise<void>>()

export function wakeCloudComputer(input?: CloudComputerWakeInput): Promise<void> {
  const key = input?.purpose ?? ''
  const existing = wakeInFlight.get(key)
  if (existing) return existing
  const run = (async () => {
    const deviceId = knownCloudDeviceId()
    await requireClient().wake(input).catch((error: unknown) => noteWakeFailure(error, deviceId))
    forgetRefusal(deviceId)
    await cloudComputer.refresh()
  })()
  const tracked = run.finally(() => {
    if (wakeInFlight.get(key) === tracked) wakeInFlight.delete(key)
  })
  wakeInFlight.set(key, tracked)
  return tracked
}

/** 关掉:管家删干净设备行、上面的智能体、沙盒与存的数据(DELETE 成功即已删)。 */
export async function destroyCloudComputer(): Promise<void> {
  const entry = cloudComputer.at()
  await requireClient().destroy()
  // 管家删干净才回成功:当场就是「没有」,「开一台云电脑」立刻回来(❌ 等下一次问到;那一次问不到时页面上什么都没有)。
  putAnswer(entry, { available: true, snapshot: { state: 'none', deviceId: null, error: null, since: new Date().toISOString() } })
  await cloudComputer.refresh()
}

/**
 * 设备列表补上云电脑那一行此刻的样子(`cloud_computer`);别的行原样。叫醒被拒的那一台(`refusedDeviceId`)不补:
 * 它醒不来,❌ 算「收回着、有事自己醒」,照库里的离线说。
 */
export function withCloudComputerPresence(
  devices: Device[],
  snapshot: CloudComputerSnapshot | null,
  now: number = Date.now(),
  refusedDeviceId: string | null = null,
): Device[] {
  if (!snapshot?.deviceId) return devices
  let changed = false
  const next = devices.map((device) => {
    const presence = device.device_id === refusedDeviceId ? null : cloudComputerPresence(device, snapshot, now)
    if ((device.cloud_computer ?? null) === presence) return device
    changed = true
    const { cloud_computer: _drop, ...rest } = device
    return presence ? { ...rest, cloud_computer: presence } : rest
  })
  return changed ? next : devices
}

/**
 * 在它上面开会话 / 打开它上面的会话这类要一条活连接的动作之前:叫醒它,等到它真的在线(每问到一次 /state 都更新界面)。
 * 原因见 CloudComputerWakeError;不是这个账号的云电脑也当失败说(调用方只对云电脑那一行调它)。
 */
export function wakeAndWaitOnline(deviceId: string, deps: { isOnline: (deviceId: string) => Promise<boolean>; signal?: AbortSignal }): Promise<void> {
  deps.signal?.throwIfAborted()
  let entry = connectionWakes.get(deviceId)
  if (!entry) {
    // Bound to the account asking: snapshots that answer after a switch do not land in the next account.
    const cache = cloudComputer.at()
    const abort = new AbortController()
    const signal = anySignal([wakeAbort.signal, abort.signal])
    // Explicit operations own resume; background pipe retries stay read-only.
    const pending = wakeCloudComputerUntilOnline({
      client: requireClient(), deviceId, isOnline: deps.isOnline, signal,
      onSnapshot: snapshot => {
        if (signal.aborted) return
        noteSnapshotError(snapshot)
        putAnswer(cache, { available: true, snapshot })
      },
    }).catch(error => { if (signal.aborted) throw error; return noteWakeFailure(error, deviceId) }).then(outcome => {
      if (outcome === 'not-cloud') throw new CloudComputerWakeError('failed', `device ${deviceId} is not this account's cloud computer`)
      forgetRefusal(deviceId)
    }).finally(() => {
      created.settled = true
      if (connectionWakes.get(deviceId) === created) connectionWakes.delete(deviceId)
    })
    const created: ConnectionWake = { promise: pending, abort, users: 0, settled: false }
    entry = created
    connectionWakes.set(deviceId, entry)
  }
  entry.users++
  if (!deps.signal) return entry.promise
  const shared = entry
  return new Promise<void>((resolve, reject) => {
    let finished = false
    const finish = (action: () => void) => {
      if (finished) return
      finished = true
      deps.signal!.removeEventListener('abort', onAbort)
      shared.users--
      if (!shared.users && !shared.settled) {
        shared.abort.abort()
        if (connectionWakes.get(deviceId) === shared) connectionWakes.delete(deviceId)
      }
      action()
    }
    const onAbort = () => finish(() => reject(deps.signal!.reason))
    // Cancelling one consumer leaves another explicit operation's wake alive.
    deps.signal!.addEventListener('abort', onAbort, { once: true })
    shared.promise.then(() => finish(resolve), error => finish(() => reject(error)))
    if (deps.signal!.aborted) onAbort()
  })
}

export type CloudComputerStepStatus = 'pending' | 'running' | 'done'

/**
 * 开通三步,每步按看得到的事实打勾(管家 10-15 说明的顺序:登录 → 设备行出现 → 上线 → 建个人助理 → awake):
 * ① 开机并登录你的账号 = /state 带上 deviceId;② 等它上线 = 设备行在线;③ 建好个人助理 = state 变 awake。
 */
export function cloudComputerProvisionSteps(
  snapshot: CloudComputerSnapshot,
  device: Pick<Device, 'is_online'> | null,
): Array<{ id: 'machine' | 'online' | 'assistant'; status: CloudComputerStepStatus }> {
  const signedIn = snapshot.deviceId !== null
  const online = signedIn && device?.is_online === true
  const ready = snapshot.state === 'awake' && online
  const machine: CloudComputerStepStatus = signedIn ? 'done' : 'running'
  const onlineStep: CloudComputerStepStatus = online ? 'done' : signedIn ? 'running' : 'pending'
  const assistant: CloudComputerStepStatus = ready ? 'done' : online ? 'running' : 'pending'
  return [
    { id: 'machine', status: machine },
    { id: 'online', status: onlineStep },
    { id: 'assistant', status: assistant },
  ]
}
