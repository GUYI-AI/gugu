// @@@1511 邀请返利前端搬运层。邀请链接就是个人短码 https://gugu.nextmind.space/j/?<gugu_number>(qrPayload.ts
// @@@short-qr,与加好友同一个码):系统把它交给 App 时(官网 /j/ 页「打开咕咕」)记下 referrer,
// 邮箱注册时塞进 signup metadata 的 referrer_gugu_number;库里 billing.claim_device_free_credits 认领注册礼包时
// 读它并调 grant_referral_reward。前端只搬运,不判防刷(自邀/重复/数额全在库里)。
// @@@referral-entry 只有一个入口:平台的「系统交来的链接」流(platform.watchOpenedLinks,桌面和安卓各自实现;网页版没有
// 系统交来的链接,官网 /j/ 页也不会把人送进网页版)。没人登录时打开的名片码才记成推荐人;登录上了就清掉。
import { parseGuguQrPayload } from '@gugu/core/shared/qrPayload'
import type { AppPlatform } from '../platform/types'
import { rendererLogger } from './log'

const PENDING_REFERRER_KEY = 'pending_referrer_gugu_number'
const log = rendererLogger('referral')

interface SessionSource { getSnapshot: () => { session: unknown }; subscribe: (listener: () => void) => () => void }

/** App 启动时订一次(平台的链接流 + 会话协调器,由 App 传进来:auth 读这里,这里不反过来 import 会话)。返回退订。 */
export function watchReferralLinks(watchOpenedLinks: AppPlatform['watchOpenedLinks'], sessions: SessionSource): () => void {
  if (!watchOpenedLinks) return () => {}
  const stopLinks = watchOpenedLinks((url) => {
    if (!sessions.getSnapshot().session) rememberReferrer(url)
  }, (error) => log.error({ err: error instanceof Error ? error.message : String(error) }, 'opened links unavailable: invite referrers are not recorded'))
  // 登录/注册成功(或恢复出一个已登录的会话):暂存的推荐人已经用过或不该用,清掉,免得算给之后在本机注册的人。
  const stopSession = sessions.subscribe(() => { if (sessions.getSnapshot().session) clearPendingReferrer() })
  return () => { stopLinks(); stopSession() }
}

function rememberReferrer(url: string): void {
  const payload = parseGuguQrPayload(url)
  if (payload?.kind !== 'contact') return
  try {
    localStorage.setItem(PENDING_REFERRER_KEY, String(payload.gugu_number))
  } catch {
    /* storage 不可用:忽略,绝不影响打开链接 */
  }
}

// 取暂存的 referrer gugu_number(纯数字串);无/非法 → null。只读,不清除。
export function consumePendingReferrer(): string | null {
  try {
    const v = localStorage.getItem(PENDING_REFERRER_KEY)
    return v && /^\d+$/.test(v) ? v : null
  } catch {
    return null
  }
}

function clearPendingReferrer(): void {
  try {
    localStorage.removeItem(PENDING_REFERRER_KEY)
  } catch {
    /* 忽略 */
  }
}
