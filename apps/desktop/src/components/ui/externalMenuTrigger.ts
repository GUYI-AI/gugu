import { useCallback, useEffect, useState } from 'react'

/**
 * A menu opened by a button React does not own — the transcript's rows are drawn by the Solid tree, so their 「侧边栏 ▾」
 * and 「登录」 buttons can't be a Base UI Trigger. This does the two things a Trigger does, so these menus follow the same
 * rule as every `DropdownMenu.Trigger` (see ui/Menu):
 *  1. a press on the button is not an outside press (otherwise its pointerdown closes the menu and its click reopens it);
 *  2. pressing the button while its menu is open closes it; pressing another button moves the menu there.
 * Pass `press` to the button's click and `onOpenChange` to the menu Root. `opened` is what the open menu shows, anchored to
 * the button element itself (Base UI follows it on scroll), never a snapshot of its rect; `last` stays after it closes, for
 * a menu that keeps its dialog mounted and reopens itself (onOpenChange(true)) at the same button.
 * The transcript is virtualized: a row scrolled away is recycled and its button leaves the DOM. A menu anchored to a
 * detached element would jump to the corner, so the menu closes when its button is no longer connected — as a Base UI
 * menu does when its Trigger unmounts.
 */
export function useExternalMenuTrigger<T>() {
  const [state, setState] = useState<{ anchor: HTMLElement; value: T; open: boolean } | null>(null)
  const press = useCallback((anchor: HTMLElement, value: T) => {
    setState((current) => current?.open && current.anchor === anchor ? { ...current, open: false } : { anchor, value, open: true })
  }, [])
  const onOpenChange = useCallback((open: boolean, details?: { reason?: string; event?: Event }) => {
    const target = details?.event?.target
    if (!open && details?.reason === 'outside-press' && target instanceof Node && state?.anchor.contains(target)) return
    setState((current) => current ? { ...current, open } : null)
  }, [state])
  const close = useCallback(() => setState((current) => current ? { ...current, open: false } : null), [])
  const openAnchor = state?.open ? state.anchor : null
  useEffect(() => {
    if (!openAnchor) return
    const closeIfDetached = () => { if (!openAnchor.isConnected) close() }
    closeIfDetached()
    const view = openAnchor.ownerDocument.defaultView
    if (!view) throw new Error('external menu trigger: its button has no window')
    const observer = new view.MutationObserver(closeIfDetached)
    observer.observe(openAnchor.ownerDocument.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [openAnchor, close])
  return { opened: state?.open ? state : null, last: state, press, onOpenChange, close }
}
