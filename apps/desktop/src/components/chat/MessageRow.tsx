import { useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { locateFindRange, paintFindHighlight } from '@gugu/session-chat-ui/find-highlight'
import { afterPaint } from '@/lib/afterPaint'
import { takeFlashWords } from '@/lib/sourceMessageReveal'

type MessageRowProps = {
  messageId: string
  children: ReactNode
  /** Flashing (msg-src-flash): it was gone to. Words a search asked for are marked inside it and fade with the flash. */
  flash?: boolean
  style?: CSSProperties
}

/** One message's row element. Its aria-posinset and aria-setsize are written by the list, which knows when they change. */
export function MessageRow({ messageId, children, flash = false, style }: MessageRowProps) {
  const ownRef = useRef<HTMLDivElement | null>(null)
  // @@@chat-offscreen-rows 行先按真实内容排一次、画出来,浏览器记下它的真实大小(contain-intrinsic-size:auto),之后才允许
  // 被跳过(data-laid-out → content-visibility:auto)。一上来就可跳过的话,挂在屏幕外的行从没排过,只有占位高度,
  // 落点 / 恢复阅读位置那一帧会按占位排、下一帧再跳回真实位置。
  useEffect(() => {
    const laidOut = afterPaint(() => ownRef.current?.setAttribute('data-laid-out', ''))
    laidOut.schedule()
    return laidOut.cancel
  }, [])
  useEffect(() => {
    const row = ownRef.current, words = flash ? takeFlashWords(messageId) : null
    if (!row || !words) return
    const owner = {}
    paintFindHighlight(document, owner, locateFindRange(row, words, 0), 'gugu-search-hit')
    return () => paintFindHighlight(document, owner, null, 'gugu-search-hit')
  }, [flash, messageId])
  return (
    // Contain the date divider's margins so the row's box (flow-list anchoring) covers the whole
    // row when an older page changes which message owns that divider.
    <div ref={ownRef} role="listitem" data-msg-id={messageId} className={flash ? 'gg-msg-row flow-root msg-src-flash' : 'gg-msg-row flow-root'} style={style}>
      {children}
    </div>
  )
}
