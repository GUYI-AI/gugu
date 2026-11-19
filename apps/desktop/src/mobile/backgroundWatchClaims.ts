/**
 * 看管机器、手机当设备和聊天消息共用一条安卓常驻通知。宿主只认一条通知或 null,
 * 两处各自开关会互相关掉对方 —— 看管的机器全离线时一句 null,手机当设备就聋了。
 *
 * 所以各自登记一句「我要它,通知上写这句」,最后一个放手才关;两句都在时并排写。
 */
import { metadataSeparator } from '@/i18n/format'
import { platform } from '../platform'
import { rendererLogger } from '../lib/log'

const log = rendererLogger('mobile/background-watch')

export type BackgroundWatchOwner = 'agentWatch' | 'phoneDevice' | 'chatNotifications'

/** 并排时的先后:看管机器在前(它是这条通知原本的用途),手机当设备在后。 */
const ORDER: readonly BackgroundWatchOwner[] = ['agentWatch', 'phoneDevice', 'chatNotifications']

/** 一家登记的那句:标题,以及(可选)它自己的正文。 */
export interface BackgroundWatchClaim {
  label: string
  text?: string
}

const claims = new Map<BackgroundWatchOwner, BackgroundWatchClaim>()

export function backgroundWatchLabel(current: ReadonlyMap<BackgroundWatchOwner, BackgroundWatchClaim>): string | null {
  const labels = ORDER.map((owner) => current.get(owner)?.label).filter((label): label is string => !!label)
  return labels.length ? labels.join(metadataSeparator()) : null
}

/** 正文只有一行:排在最前的那家给了就用它的,没给(看管机器)就用宿主默认那句。 */
export function backgroundWatchText(current: ReadonlyMap<BackgroundWatchOwner, BackgroundWatchClaim>): string | undefined {
  const first = ORDER.map((owner) => current.get(owner)).find((claim) => claim !== undefined)
  return first?.text
}

function apply(): void {
  if (!platform.capabilities.backgroundWatch) return
  void platform.setBackgroundWatch(backgroundWatchLabel(claims), backgroundWatchText(claims)).catch((error: unknown) => {
    // 起不来(例如系统不让从后台启前台服务)就照实记一条 —— ❌ 吞掉:吞掉之后「切后台就收不到 / 调不到」在任何地方都不显形。
    log.error({ error: String(error), owners: [...claims.keys()] }, '后台守着没起来,切后台之后收不到提醒、助理也调不到这台手机')
  })
}

/** 登记(或改字);返回放手。同一个 owner 再登记一次 = 改通知上的字,不会闪。 */
export function claimBackgroundWatch(owner: BackgroundWatchOwner, label: string, text?: string): () => void {
  const claim: BackgroundWatchClaim = { label, text }
  claims.set(owner, claim)
  apply()
  return () => {
    if (claims.get(owner) !== claim) return
    claims.delete(owner)
    apply()
  }
}
