import { useRef, useState, type MouseEvent } from 'react'
import { capturePhoneTextSelection, type PhoneTextSelectionSource } from './phoneTextSelectionSource'

/**
 * 一条气泡上手机长按的两段状态:菜单开过一次就一直挂着(收起要播完退场动画,由 open 开合);
 * 「选择文本」期间气泡放开选字。
 */
export function usePhoneMessageMenu(open: boolean) {
  const [mounted, setMounted] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const source = useRef<PhoneTextSelectionSource | null>(null)
  if (open && !mounted) setMounted(true)
  const captureAt = (bubble: HTMLElement | null, x: number, y: number) => {
    // Android may deliver contextmenu after the touch timer has already lifted the message.
    if (bubble?.style.visibility === 'hidden') return
    source.current = capturePhoneTextSelection(bubble, x, y)
  }
  return { mounted, selecting, setSelecting, captureAt, source: source.current }
}

/** 气泡上开菜单的手势:右键 / 系统长按 / 触摸长按都开同一份菜单;选字期间都还给系统(拖把手、改范围)。 */
export function bubbleMenuGestures<T extends object>(longPress: T, openAt: (x: number, y: number) => void, selecting: boolean) {
  if (selecting) return {}
  return {
    ...longPress,
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      openAt(event.clientX, event.clientY)
    },
  }
}
