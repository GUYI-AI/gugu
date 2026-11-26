import { useEffect, type ReactNode } from 'react'
import { toast as sonner } from 'sonner'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { TOAST_DWELL_MS, isReadableTier, type ToastTier } from './toastTiers'
import { rendererLogger } from './log'
import { requestToasterId } from '@renderer/app/aux-layers'

const noticeLog = rendererLogger('notice')

/**
 * 全 app 唯一的提示出口(#137)。谁调都落到 NoticeHost.tsx 那一处,位置只由寿命决定(owner 11-22 选的 B):
 *  · 转瞬(默认):一条确认,到点消失,画在提示条上。通常在 composer 上方居中，也可指定右下角。
 *    `duration: Infinity` 是「要你当场看到、处理了才走」的提醒(会议即将开始):同一个位置,不自己消失,带关闭钮。
 *  · 常驻(`ongoing`):「这件事还没完、要你做个决定」,画在右上角那一叠卡上 —— 窗口按钮那条车道下面,浮在内容上、
 *    在所有弹窗之下(--z-notice),一次露一张,「‹ 1/N ›」翻其余。用户点「以后再说」= 收进铃铛(NeedsYou 列表),
 *    在铃铛里清掉才算关(onDismiss)。它描述的状态结束了(同 key 再发 / dismissNotice)就收掉,不管在卡上还是铃铛里。
 * ❌ 别处自己画提示框、自己定位、自己定 z(tests/unit/desktop/noticeOutlets.test.ts 钉着)。
 *
 * key —— 同一个 key 永远是同一条:再发一次 = 原地更新它,❌ 叠一条新的;一件事从转瞬变常驻(或反过来)也还是这一条,
 * 只换位置。一件事的状态在变(重连中 → 失败 / 恢复),就用 key 把它们串成一条。
 */
export interface Notice {
  /** 同 key = 同一条,原地更新。不给 = 一次性的新提示。 */
  key?: string
  title?: string
  description?: ReactNode
  /**
   * 档位与会话页、主 app 同一套(#4891)。没给 = 旧行为一字不变(见下面 `variant`),
   * ❌ 把没迁的调用一次性改成 info 样式 + 3s 停留,是一次没人审过的外观变更。
   */
  tier?: ToastTier
  /** @deprecated 用 `tier`。留着是为了不把 80 多处调用堵在一个 PR 里,迁完即删。 */
  variant?: 'default' | 'destructive'
  /** 这件事还没完、要你做个决定:进右上角那一叠卡(收起后在铃铛里),不按停留消失。 */
  ongoing?: boolean
  /**
   * 常驻的默认带关闭钮。`false` = 只能由它的结果收掉:它陈述的是一个持续为真、用户关了也改变不了的事实(登录失效)。
   * 只对常驻有意义。
   */
  dismissible?: false
  /** 在等:图标是产品里唯一的那个加载态(loading-state spec),❌ 另画 spinner。 */
  waiting?: boolean
  action?: { label: string; onClick: () => void }
  icon?: ReactNode
  /** 转瞬的:带一次性动作(撤销)的要留够点它的时间;不给就是档位的停留。 */
  duration?: number
  position?: 'bottom-right'
  /**
   * 用户亲手关掉了这一条(关闭钮 / 滑走)。`dismissNotice` 收的、同 key 换内容 / 换位置的都**不**算 ——
   * sonner 对程序收的那条也会回调,而且晚一帧:那时同 key 可能已经是新的一条,调用方按 key 记的状态分不出是哪一条。
   */
  onDismiss?: () => void
  /** The visible notice expired; callers may release state scoped to that notice. */
  onAutoClose?: () => void
}

/**
 * key → 它此刻在 sonner 里的 id。一条提示结束了(被收、被关、到点消失)这个 id 就作废,同 key 再发是新的一条:
 *  · sonner 的收(dismiss)排到下一帧才执行,同 id 紧接着再发,新的那条会被这次收顺手杀掉,还会触发它的 onDismiss
 *    (实测:新建页切到项目页,离线提示没了、而且被当成用户关的,不再回来);
 *  · 同 id 的更新是 `{...旧的, ...新的}`,沿用结束了的 id 就会继承上一条的字段。
 * 还活着的同 key 提示照旧原地更新(同一个 id)。
 */
const liveIds = new Map<string, string>()
/** `dismissNotice` 收掉的 id:sonner 收完照样回调 onDismiss,那不是用户关的。 */
const dismissedByApp = new Set<string>()
let idSeq = 0

const SONNER_BY_TIER = {
  success: sonner.success,
  error: sonner.error,
  warning: sonner.warning,
  info: sonner.info,
} as const

export function notify(notice: Notice): string | number {
  if (notice.key !== undefined) {
    // 同一件事只在一个位置:换到另一处之前,把它在原处的那一条收掉(不算用户关的)。
    if (notice.ongoing) dismissToast(notice.key)
    else persistent().remove(notice.key)
  }
  if (notice.ongoing) return showPersistent(notice)
  return showToast(notice)
}

function showToast({ key, title, description, tier, variant, waiting, action, icon, duration, position, onDismiss, onAutoClose }: Notice): string | number {
  // 转瞬的确认(成功 / 提示、没有动作)点击穿透,别挡住下面的按钮一个停留周期。
  const passthrough = !action && (tier === 'success' || tier === 'info')
  // 每个字段都显式给(没有就是 undefined):sonner 更新同 id 的提示时是 `{...旧的, ...新的}`,省略的字段会沿用上一次。
  let id: string | undefined
  const live = key !== undefined && liveIds.has(key)
  if (key !== undefined) {
    id = liveIds.get(key) ?? `${key}#${++idSeq}`
    liveIds.set(key, id)
  }
  const retire = () => {
    if (key !== undefined && liveIds.get(key) === id) liveIds.delete(key)
  }
  const options = {
    ...(id !== undefined && { id }),
    description,
    icon: waiting ? <LoadingIndicator size="inline" /> : icon,
    action: action ? { label: action.label, onClick: action.onClick } : undefined,
    onDismiss: () => {
      if (id !== undefined && dismissedByApp.delete(id)) return
      retire()
      onDismiss?.()
    },
    onAutoClose: () => {
      retire()
      onAutoClose?.()
    },
    className: passthrough ? 'gugu-notice-passthrough' : undefined,
    duration,
    ...(position || live ? { position } : {}),
    // 不自己消失的(提醒)一定能当场关掉。
    closeButton: duration === Infinity ? true : undefined as boolean | undefined,
    // A new toast shows in the window it was asked from (aux-layers; NoticeHost draws a strip in each pop-out). One
    // updated in place stays where it is: sonner keeps the field it is not given.
    ...(!live && { toasterId: requestToasterId() }),
  }

  logIfRead({ key, title, description, tier, variant })

  // 没显式给档位的调用行为一字不变。
  if (!tier) {
    if (variant === 'destructive') return sonner.error(title ?? '', options)
    return sonner(title ?? '', options)
  }

  return SONNER_BY_TIER[tier](title ?? '', {
    ...options,
    duration: options.duration ?? TOAST_DWELL_MS[tier],
    // 要读要复制的那两档必须能当场关掉 —— 停留翻倍之后,「不可关闭」比「短暂遮挡」更难受。
    closeButton: duration === Infinity || isReadableTier(tier),
  })
}

/** 用户读到的失败 / 告警原样落盘(只是本机日志):日志里的错误行说不清用户当时看见了哪一句。 */
function logIfRead({ key, title, description, tier, variant }: Pick<Notice, 'key' | 'title' | 'description' | 'tier' | 'variant'>): void {
  if (tier === 'error' || tier === 'warning' || (!tier && variant === 'destructive')) {
    noticeLog.warn({ tier: tier ?? 'error', key, title, description: typeof description === 'string' ? description : undefined }, 'notice shown')
  }
}

function dismissToast(key: string): void {
  const id = liveIds.get(key)
  if (id === undefined) return
  liveIds.delete(key)
  dismissedByApp.add(id)
  sonner.dismiss(id)
}

// ── 常驻:右上角那一叠卡,「以后再说」收进铃铛 ─────────────────────────────────────────────────────────────

/** 一条常驻通知:就是那条 Notice,外加进来的先后(翻页按先后)和它在哪 —— 卡片叠里,还是用户收进了铃铛。 */
export type PersistentNotice = Notice & { key: string; seq: number; deferred: boolean }

/**
 * 常驻通知的状态。主 app 与会话页各是各的 bundle,模块变量不跨入口,所以挂在 globalThis 上(同 sonner 共用一份的道理):
 * 谁发的常驻都落到同一叠卡、同一个铃铛。
 */
interface PersistentStore {
  list: readonly PersistentNotice[]
  listeners: Set<() => void>
  remove(key: string): PersistentNotice | undefined
}
const PERSISTENT = Symbol.for('gugu.notice.persistent')
function persistent(): PersistentStore {
  const holder = globalThis as { [PERSISTENT]?: PersistentStore }
  holder[PERSISTENT] ??= {
    list: [],
    listeners: new Set(),
    remove(key) {
      const gone = this.list.find((notice) => notice.key === key)
      if (gone) publish(this.list.filter((notice) => notice !== gone))
      return gone
    },
  }
  return holder[PERSISTENT]
}
function publish(list: readonly PersistentNotice[]): void {
  const store = persistent()
  store.list = list
  for (const listener of store.listeners) listener()
}
let persistentSeq = 0

function showPersistent(notice: Notice): string {
  const key = notice.key ?? `notice#${++persistentSeq}`
  const { list } = persistent()
  const current = list.find((entry) => entry.key === key)
  if (!current || current.title !== notice.title || current.tier !== notice.tier) logIfRead({ ...notice, key })
  // 用户收进铃铛的,同一件事还在原样往前走(进度在动、说明在变)就还在铃铛里;换了标题 = 进到了新的状态
  // (可用 → 已就绪、安装中 → 失败),是一个新的决定,回到卡片叠上。
  const deferred = current?.deferred === true && current.title === notice.title
  const next: PersistentNotice = { ...notice, key, seq: current?.seq ?? ++persistentSeq, deferred }
  publish(current ? list.map((entry) => (entry === current ? next : entry)) : [...list, next])
  return key
}

/** 常驻通知的读口:卡片叠(NoticeHost)和铃铛列表(NeedsYouHost)读同一份。 */
export const persistentNotices = {
  subscribe(listener: () => void): () => void {
    const { listeners } = persistent()
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  read: (): readonly PersistentNotice[] => persistent().list,
  /** 用户在卡片上点了「以后再说」/ ✕:这条离开卡片叠,收进铃铛,还在、还能处理。不算关掉(不回调 onDismiss)。 */
  defer(key: string): void {
    const { list } = persistent()
    if (!list.some((entry) => entry.key === key && entry.dismissible !== false)) return
    publish(list.map((entry) => (entry.key === key ? { ...entry, deferred: true } : entry)))
  },
  /** 用户在铃铛里把它清掉了:这才是「关掉」,回调 onDismiss(调用方据此记住不再提)。 */
  clear(key: string): void {
    persistent().remove(key)?.onDismiss?.()
  },
}

/** 收掉一条(按它的 key),不管它在哪个位置。没有这条 = 什么都不发生。不算用户关的(不回调 onDismiss)。 */
export function dismissNotice(key: string): void {
  persistent().remove(key)
  dismissToast(key)
}

/**
 * 同一个出口的声明式写法:给一条 = 它在(每次渲染原地更新),给 null 或卸载 = 收掉。
 * 给内容会变的常驻(安装进度、SSH 提问):状态留在调用方的组件里,画在右上角那一叠卡上。
 */
export function useNotice(key: string, notice: Omit<Notice, 'key'> | null): void {
  useEffect(() => {
    if (notice) notify({ ...notice, key })
    else dismissNotice(key)
  })
  useEffect(() => () => dismissNotice(key), [key])
}
