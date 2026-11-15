import { useCallback, useEffect, useRef } from 'react'
import type { CSSProperties, MouseEventHandler, ReactNode, Ref } from 'react'
import { afterPaint } from '@/lib/afterPaint'

type MessageRowProps = {
  messageId: string
  index: number
  count: number
  children: ReactNode
  rowRef?: Ref<HTMLDivElement>
  className?: string
  style?: CSSProperties
  onContextMenu?: MouseEventHandler<HTMLDivElement>
}

export function MessageRow({ messageId, index, count, children, rowRef, className, style, onContextMenu }: MessageRowProps) {
  const ownRef = useRef<HTMLDivElement | null>(null)
  const setRef = useCallback((node: HTMLDivElement | null) => {
    ownRef.current = node
    if (typeof rowRef === 'function') rowRef(node)
    else if (rowRef) rowRef.current = node
  }, [rowRef])
  // @@@chat-offscreen-rows 行先按真实内容排一次、画出来,浏览器记下它的真实大小(contain-intrinsic-size:auto),之后才允许
  // 被跳过(data-laid-out → content-visibility:auto)。一上来就可跳过的话,挂在屏幕外的行从没排过,只有占位高度,
  // 落点 / 恢复阅读位置那一帧会按占位排、下一帧再跳回真实位置。
  useEffect(() => {
    const laidOut = afterPaint(() => ownRef.current?.setAttribute('data-laid-out', ''))
    laidOut.schedule()
    return laidOut.cancel
  }, [])
  return (
    // Contain the date divider's margins so the row's box (flow-list anchoring) covers the whole
    // row when an older page changes which message owns that divider.
    <div ref={setRef} role="listitem" aria-posinset={index + 1} aria-setsize={count} data-msg-id={messageId} className={className ? `gg-msg-row flow-root ${className}` : 'gg-msg-row flow-root'} style={style} onContextMenu={onContextMenu}>
      {children}
    </div>
  )
}
