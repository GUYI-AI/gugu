import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { composerSlotClass, composerSlotInnerClass } from '@gugu/session-chat-ui/composer-layout'

/** 底部那一摞的实测高度,挂在它所在的那一栏上;消息流末尾(MessageList)和空态占位都按它让位。 */
const CHAT_DOCK_HEIGHT_VAR = '--chat-dock-h'
const CHAT_DOCK_AVATAR_HEIGHT_VAR = '--chat-dock-avatar-h'

// @@@dock-height-rule — both heights used to be inline vars on the column. Custom properties inherit, so every dock
// resize (a reply chip, a wrapped line) restyled the whole conversation: 12.6k elements, ~100 ms per change.
// They are registered non-inheriting (tokens.css) and set by one rule on the [data-chat-dock-reads] elements only.
let dockSheet: CSSStyleSheet | undefined
function dockRule(column: string): CSSStyleRule {
  dockSheet ??= document.head.appendChild(document.createElement('style')).sheet!
  return dockSheet.cssRules[dockSheet.insertRule(`[data-chat-dock-column="${column}"] [data-chat-dock-reads] {}`, dockSheet.cssRules.length)] as CSSStyleRule
}

/**
 * Chat composers use the same slot frame as ACP tasks.
 *
 * 底部那一摞浮在消息流上,自己没有底(owner 10-25「应该是透明的」「用户感受到的这块应该是一个空地」):
 * 消息从回复条后面滚过去,看得见;要底的只有回复条、输入框那几张卡自己。
 * 它把自己的高度写成所在那一栏里 [data-chat-dock-reads] 元素的 --chat-dock-h,消息流在最后一条后面让出同样高的一格,滚到底时最后一条落在输入框上面。
 * reserve:没有消息流可让(空态、骨架)时,在列底占一格同高的位置,空态的内容不被盖住。
 */
export function ChatBottomDock({ reserve, children }: { reserve: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const columnId = useId()
  useLayoutEffect(() => {
    const el = ref.current, column = el?.parentElement
    if (!el || !column) return
    const input = el.lastElementChild as HTMLElement
    column.setAttribute('data-chat-dock-column', columnId)
    const rule = dockRule(columnId)
    // @@@dock-rule-writes - a write to the rule re-matches it against the whole document (a stylesheet change), even with the
    // same value. The dock's width changes in every frame of a sidebar fold and its observer fires each time: write only a
    // changed height, so a fold costs no document-wide pass per frame.
    let written = ''
    const report = () => {
      const top = input.offsetTop
      const height = el.offsetHeight
      if (written === `${height} ${top}`) return
      written = `${height} ${top}`
      rule.style.setProperty(CHAT_DOCK_HEIGHT_VAR, `${height}px`)
      rule.style.setProperty(CHAT_DOCK_AVATAR_HEIGHT_VAR, `${height - top}px`)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => { observer.disconnect(); dockSheet!.deleteRule([...dockSheet!.cssRules].indexOf(rule)); column.removeAttribute('data-chat-dock-column') }
  }, [columnId])
  return (
    <>
      {reserve && <div aria-hidden data-chat-dock-reads="" className="h-[var(--chat-dock-h,0px)] shrink-0" />}
      <div ref={ref} data-chat-bottom-dock="" className={`${composerSlotClass} absolute!`}>
        <div className={composerSlotInnerClass}>{children}</div>
      </div>
    </>
  )
}
