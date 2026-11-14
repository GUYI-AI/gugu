/**
 * 回答者标识,进 `Settlement.resolvedBy`,只用于显示「已在某端回答」(哪一端答的,不是设备 id)。
 */
export const MOBILE_RESPONDER_ID = 'mobile'

/** `resolvedBy` 说成人话:手机端 / 桌面端;认不出的原样。 */
export function responderName(by: string | null, t: (key: string) => string): string | null {
  if (!by) return null
  if (by === MOBILE_RESPONDER_ID) return t('agentWatch.settlement.byMobile')
  if (by === 'desktop') return t('agentWatch.settlement.byDesktop')
  return by
}
