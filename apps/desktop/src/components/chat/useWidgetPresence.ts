import { useLayoutEffect, useState, type RefObject } from 'react'
import { clippedElementBox } from '../../lib/elementVisibility'
import { widgetPresenceOf, type WidgetPresence } from './widgetPresence'

/** The list a slot scrolls in: on a phone its page is mounted half of that list's height ahead (contract r13). */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node
  }
  return null
}

export function useWidgetPresence(chatId: string, widgetId: string, ref: RefObject<HTMLDivElement | null>, shown: boolean, preload: boolean) {
  const [slot, setSlot] = useState<{ presence: WidgetPresence; token: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    // Taken when the slot registers: a chat's presence is dropped once its last slot is released (`emptied`).
    const presence = widgetPresenceOf(chatId)
    const id = presence.register(widgetId, element)
    setSlot({ presence, token: id })
    const scroller = preload ? scrollerOf(element) : null
    const measure = () => {
      const { full, clip } = clippedElementBox(element, { left: 0, top: 0, width: innerWidth, height: innerHeight })
      const seen = element.isConnected && document.visibilityState !== 'hidden' && element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      const visible = shown && seen && clip.width > 0 && clip.height > 0
      const list = scroller?.getBoundingClientRect()
      const nearby = !!list && seen && full.top < list.bottom + list.height / 2 && full.top + full.height > list.top - list.height / 2
      presence.update(id, { visible, nearby, bottom: full.top + full.height, ratio: visible && full.height > 0 ? clip.height / full.height : 0 })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    document.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    document.addEventListener('visibilitychange', measure)
    return () => {
      presence.release(id)
      observer.disconnect()
      document.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
      document.removeEventListener('visibilitychange', measure)
    }
  }, [chatId, widgetId, ref, shown, preload])
  return { active: shown && !!slot && slot.presence.owners.get(widgetId) === slot.token,
    preload: preload && !!slot && slot.presence.preloads.get(widgetId) === slot.token,
    locate: () => slot?.presence.locate(widgetId) }
}
