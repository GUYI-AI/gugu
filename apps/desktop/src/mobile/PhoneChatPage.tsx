import { Capacitor } from '@capacitor/core'
import { useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from 'react'
import { RETAINED_SURFACE_HIDDEN_STYLE, SurfaceShown } from '../lib/retainedSurface'
import { installPhoneChatMotion, type PhoneChatMotionState } from './phoneChatMotion'
import './phone-chat-page.css'

export type PhoneChatPageHandle = { back(): boolean }

/** One retained chat page, over the pager's real origin page on phones and beside its list on desktop. */
export function PhoneChatPage({ mobile, shown, covered = false, enabled, desktopShown, place, onBack, children, ref }: {
  mobile: boolean; shown: boolean; covered?: boolean; enabled: boolean; desktopShown: boolean; place: string | null
  onBack: () => void; children: ReactNode; ref: Ref<PhoneChatPageHandle>
}) {
  const page = useRef<HTMLDivElement>(null), dim = useRef<HTMLDivElement>(null)
  const visible = mobile ? shown : desktopShown
  const state = useRef<PhoneChatMotionState>({ shown: visible, enabled, place, onBack })
  state.current = { shown: visible, enabled, place, onBack }
  const motion = useRef<ReturnType<typeof installPhoneChatMotion> | null>(null)
  const wasShown = useRef(shown)
  useImperativeHandle(ref, () => ({ back: () => motion.current?.back() ?? false }), [])
  useLayoutEffect(() => {
    const element = page.current, shade = dim.current
    const underlay = element?.parentElement?.querySelector<HTMLElement>('[data-mobile-tab-pager]')
    if (!mobile || !element || !shade || !underlay) return
    const controller = installPhoneChatMotion(element, underlay, shade, () => state.current, Capacitor.getPlatform() === 'ios')
    motion.current = controller
    return () => { controller.destroy(); motion.current = null }
  }, [mobile])
  useLayoutEffect(() => {
    if (shown && !wasShown.current) motion.current?.open()
    else motion.current?.reset()
    wasShown.current = shown
  }, [shown, enabled, place])
  return <>
    <div ref={dim} className="gg-phone-chat-dim" aria-hidden="true" />
    <div ref={page} data-shell-chat-detail="" className="gg-phone-chat-page" data-mobile={mobile || undefined}
      inert={!visible || (mobile && covered)}
      style={visible ? undefined : RETAINED_SURFACE_HIDDEN_STYLE}>
      <SurfaceShown shown={visible && !(mobile && covered)}>{children}</SurfaceShown>
    </div>
  </>
}
