import { useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { afterPaint } from '@/lib/afterPaint'

type MessageRowProps = {
  messageId: string
  children: ReactNode
  className?: string
  style?: CSSProperties
}

/** One message's row element. Its aria-posinset and aria-setsize are written by the list, which knows when they change. */
export function MessageRow({ messageId, children, className, style }: MessageRowProps) {
  const ownRef = useRef<HTMLDivElement | null>(null)
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
    <div ref={ownRef} role="listitem" data-msg-id={messageId} className={className ? `gg-msg-row flow-root ${className}` : 'gg-msg-row flow-root'} style={style}>
      {children}
    </div>
  )
}
