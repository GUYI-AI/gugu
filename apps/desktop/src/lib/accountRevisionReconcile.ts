// R2 — 修订流的对账触发器。realtime 广播是「有新东西」的提示,不是投递保证:桌面端的私有事件通道
// 关了空闲重连(reconnectWhenIdle:false),睡眠、断网、后台节流期间丢掉的 wake 不会重发 ⇒ 新消息要等
// 下一条广播才出现。这里补上与广播无关的拉取时机:定时对账 + 回到前台 / 页面可见 / 联网 / 系统唤醒。
// 定时对账是一次 head 未知的 wake(runtime 照常合并并发、按游标增量拉),代价是一次有界的读。
// 回到前台 / 页面可见 / 联网是「条件变了」(resume):上一次读失败留下的退避从头算,立刻读一次 —— 联网那一刻发出的
// 读常常还连不上,它失败后 1 秒重试,而不是等完离线期间涨到 30 秒的退避。

import { platform } from '../platform'
import { rendererLogger } from './log'

const reconcileLog = rendererLogger('chat/account-revision-reconcile')

export const REVISION_RECONCILE_INTERVAL_MS = 25_000

type Unsubscribe = () => void

export interface RevisionReconcileSignals {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  /** 页面从隐藏变为可见。 */
  onVisible(listener: () => void): Unsubscribe
  /** 网络恢复。 */
  onOnline(listener: () => void): Unsubscribe
  /** 应用回到前台:桌面端 = 窗口聚焦 + 系统从睡眠唤醒(main 的 powerMonitor.resume);移动端 = App resume。 */
  onForeground(listener: () => void): Unsubscribe
}

export function watchRevisionReconcile(
  advance: (kind: 'wake' | 'resume') => void,
  signals: RevisionReconcileSignals,
  intervalMs = REVISION_RECONCILE_INTERVAL_MS,
): Unsubscribe {
  const resume = () => advance('resume')
  const timer = signals.setInterval(() => advance('wake'), intervalMs)
  const stops = [signals.onVisible(resume), signals.onOnline(resume), signals.onForeground(resume)]
  return () => {
    signals.clearInterval(timer)
    for (const stop of stops) stop()
  }
}

function rendererReconcileSignals(): RevisionReconcileSignals {
  return {
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    onVisible: (listener) => {
      const onChange = () => { if (document.visibilityState === 'visible') listener() }
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    },
    onOnline: (listener) => {
      window.addEventListener('online', listener)
      window.addEventListener('gugu:ios-push-reconcile', listener)
      return () => {
        window.removeEventListener('online', listener)
        window.removeEventListener('gugu:ios-push-reconcile', listener)
      }
    },
    onForeground: (listener) => platform.subscribeAppForeground(listener, (error) => {
      reconcileLog.error({ error }, 'app foreground subscription failed')
    }),
  }
}

/** The renderer's reconcile beat: the interval wakes, visible / online / foreground resume. */
export function watchRendererRevisionReconcile(advance: (kind: 'wake' | 'resume') => void): Unsubscribe {
  return watchRevisionReconcile(advance, rendererReconcileSignals())
}
