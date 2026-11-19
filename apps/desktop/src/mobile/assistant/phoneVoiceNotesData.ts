// #7199 手机录音条(PhoneVoiceBar)上失败那一句,照桌面 failureText。
/** 失败那一句(照桌面 failureText):网关明说的原话 > 签票原因码的那一句 > 按环节的通用一句。 */
const FAILURE_CODES = new Set(['signed-out', 'membership-required', 'model-unavailable', 'unreachable', 'service-unavailable'])
export function voiceFailureText(
  t: (key: string, values?: Record<string, string>) => string,
  view: { stage: string; notice: string | null; code: string | null; message: string },
  name: string,
): string {
  if (view.notice) return view.notice
  if (view.code && FAILURE_CODES.has(view.code)) return t(`failure.code.${view.code}`)
  if (view.message === 'unreadable') return t('failure.unreadable')
  return t(`failure.${view.stage}`, { name })
}
