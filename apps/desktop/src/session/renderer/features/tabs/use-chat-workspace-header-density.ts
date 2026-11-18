import { useEffect, useState, type RefObject } from 'react'

type ChatHeaderDensity = 'labeled' | 'icons' | 'menu'
const CHAT_HEADER_LABELS_MIN_WIDTH = 400
const CHAT_HEADER_ICONS_MIN_WIDTH = 300

/** The portal uses the width of the chat column that actually holds its header. */
export function useChatWorkspaceHeaderDensity(ref: RefObject<HTMLElement | null>) {
  const [density, setDensity] = useState<ChatHeaderDensity>()
  useEffect(() => {
    const column = ref.current?.closest<HTMLElement>('[data-chat-workspace-chat-header]')
    if (!column) return
    const header = column.closest<HTMLElement>('[data-chat-workspace-header]')
    const measure = () => {
      const target = header?.dataset.chatWorkspaceHeader === 'split' ? column : header ?? column
      const width = target.getBoundingClientRect().width
      if (width > 0) setDensity(width >= CHAT_HEADER_LABELS_MIN_WIDTH ? 'labeled' : width >= CHAT_HEADER_ICONS_MIN_WIDTH ? 'icons' : 'menu')
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    if (header) observer.observe(header)
    return () => observer.disconnect()
  }, [ref])
  return density
}
