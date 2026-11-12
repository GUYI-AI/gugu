// @@@1511 邀请返利前端搬运层。邀请链接就是个人短码 https://gugu.nextmind.space/j/?<gugu_number>(qrPayload.ts
// @@@short-qr,与加好友同一个码):系统把它交给 App 时(官网 /j/ 页「打开咕咕」,登录前也会到)记下 referrer,
// 邮箱注册时塞进 signup metadata 的 referrer_gugu_number;库里 billing.claim_device_free_credits 认领注册礼包时
// 读它并调 grant_referral_reward。前端只搬运,不判防刷(自邀/重复/数额全在库里)。
// 只有这一个记录函数,各端只负责把「打开的链接」交进来(@@@referral-entry):安卓 appUrlOpen(capacitorOpenedLinks)、
// 桌面系统打开的 gugu:// 链接(main 全量转给渲染层,electronAuthCallbacks)、网页版页面自己的地址(main.tsx)。
import { parseGuguQrPayload } from '@gugu/core/shared/qrPayload'

const PENDING_REFERRER_KEY = 'pending_referrer_gugu_number'

// 系统交给 App 的链接:是个人短码就暂存它的咕咕号,待注册时用。别的链接不动。
export function rememberReferrerFromLink(url: string): void {
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

// 注册/登录成功后清掉已用的邀请码(避免给后续在本机登录的人误带 referrer)。
export function clearPendingReferrer(): void {
  try {
    localStorage.removeItem(PENDING_REFERRER_KEY)
  } catch {
    /* 忽略 */
  }
}
