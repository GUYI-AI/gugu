import { useEffect, type ReactNode } from 'react'
import { toast as sonner } from 'sonner'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { TOAST_DWELL_MS, isReadableTier, type ToastTier } from './toastTiers'
import { rendererLogger } from './log'

const noticeLog = rendererLogger('notice')

/**
 * 全 app 唯一的提示出口(#137)。谁调都落到 NoticeHost.tsx 那一处,位置只由寿命决定(owner 11-22 方案 A):
 *  · 转瞬(默认):一条确认,到点消失,画在提示条上 —— composer 上方,一次一条(sonner,两个 React 根共用一份状态)。
 *  · 常驻(`ongoing`):「这件事还没完」,画在横幅位上 —— 页面最上面那一行,占文档流,一次露一条、翻页看其余
 *    (NoticeBannerSlot)。它描述的状态不变就一直在,由它的结果(同 key 再发、dismissNotice)收掉。
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
  /** 这件事还没完:进横幅位,不按停留消失。 */
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
    else banners().remove(notice.key)
  }
  if (notice.ongoing) return showBanner(notice)
  return showToast(notice)
}

function showToast({ key, title, description, tier, variant, waiting, action, icon, duration, onDismiss, onAutoClose }: Notice): string | number {
  // 转瞬的确认(成功 / 提示、没有动作)点击穿透,别挡住下面的按钮一个停留周期。
  const passthrough = !action && (tier === 'success' || tier === 'info')
  // 每个字段都显式给(没有就是 undefined):sonner 更新同 id 的提示时是 `{...旧的, ...新的}`,省略的字段会沿用上一次。
  let id: string | undefined
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
    closeButton: undefined as boolean | undefined,
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
    closeButton: isReadableTier(tier),
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

// ── 横幅位(常驻) ────────────────────────────────────────────────────────────────────────────────────────────

/** 横幅位上的一条:就是那条 Notice,外加它进来的先后(翻页按先后)。 */
export type Banner = Notice & { key: string; seq: number }

/**
 * 横幅位的状态。主 app 与会话页各是各的 bundle,模块变量不跨入口,所以挂在 globalThis 上(同 sonner 共用一份的道理):
 * 谁发的常驻都落到同一个横幅位。
 */
interface BannerStore {
  list: readonly Banner[]
  listeners: Set<() => void>
  remove(key: string): Banner | undefined
}
const BANNERS = Symbol.for('gugu.notice.banners')
function banners(): BannerStore {
  const holder = globalThis as { [BANNERS]?: BannerStore }
  holder[BANNERS] ??= {
    list: [],
    listeners: new Set(),
    remove(key) {
      const gone = this.list.find((banner) => banner.key === key)
      if (gone) publish(this.list.filter((banner) => banner !== gone))
      return gone
    },
  }
  return holder[BANNERS]
}
function publish(list: readonly Banner[]): void {
  const store = banners()
  store.list = list
  for (const listener of store.listeners) listener()
}
let bannerSeq = 0

function showBanner(notice: Notice): string {
  const key = notice.key ?? `banner#${++bannerSeq}`
  const { list } = banners()
  const current = list.find((banner) => banner.key === key)
  if (!current || current.title !== notice.title || current.tier !== notice.tier) logIfRead({ ...notice, key })
  const next: Banner = { ...notice, key, seq: current?.seq ?? ++bannerSeq }
  publish(current ? list.map((banner) => (banner === current ? next : banner)) : [...list, next])
  return key
}

/** 横幅位的读口(只给 NoticeBannerSlot 用)。 */
export const bannerFeed = {
  subscribe(listener: () => void): () => void {
    const { listeners } = banners()
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  read: (): readonly Banner[] => banners().list,
  /** 用户在横幅上点了关闭。 */
  close(key: string): void {
    banners().remove(key)?.onDismiss?.()
  },
}

/** 收掉一条(按它的 key),不管它在哪个位置。没有这条 = 什么都不发生。不算用户关的(不回调 onDismiss)。 */
export function dismissNotice(key: string): void {
  banners().remove(key)
  dismissToast(key)
}

/**
 * 同一个出口的声明式写法:给一条 = 它在(每次渲染原地更新),给 null 或卸载 = 收掉。
 * 给内容会变的常驻(安装进度、SSH 提问、会议提醒):状态留在调用方的组件里,画在横幅位上。
 */
export function useNotice(key: string, notice: Omit<Notice, 'key'> | null): void {
  useEffect(() => {
    if (notice) notify({ ...notice, key })
    else dismissNotice(key)
  })
  useEffect(() => () => dismissNotice(key), [key])
}
