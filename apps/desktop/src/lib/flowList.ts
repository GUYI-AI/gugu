import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { PREPARE_SELECT_ALL_EVENT } from '../../shared/window-menu-commands'
import { afterPaint } from './afterPaint'

/**
 * 消息列表的滚动机制(#6595):挂上的那段消息按文档流排(store 已把窗口限在 MAX_WINDOW 行内),位置交给浏览器。
 *
 * 为什么不再用虚拟列表:react-virtuoso 关掉原生滚动锚定(overflow-anchor:none),自己用 JS 补偿 —— 视口上方任何一行
 * 变高(第一次露出来、翻页插在上面、图片/代码高亮晚到),它先挪 scrollTop、下一次 React 提交才补上高度,中间那一帧
 * 就是一次回跳(owner:「往上滚看历史 ui 有点震荡」)。文档流 + 原生锚定由浏览器在同一次排版里改位置,画出来已经对了;
 * 我们自己动位置的地方(落点、贴底、翻页)也都放在布局之后、绘制之前(layout effect / ResizeObserver 回调)。
 *
 * 只渲染落点附近的视口和一屏余量(不够就再补,都在第一次绘制之前),滚到边缘再沿同一切片补行,不卸载已挂的行:
 * 一次排出整窗 markdown(代码块、表格)会把第一帧拖慢几十毫秒。补在上方的行由头部插行那一步把正看着的行钉在原处。
 */

const FIRST_FRAME_ROWS = 6
const GROW_ROWS = 12

export type ListLanding =
  | { index: 'LAST'; align: 'end' }
  | { index: number; align: 'start'; offset?: number }

export interface FlowListHandle {
  scrollToIndex(location: { index: number; align?: 'start' | 'center' | 'end'; offset?: number; behavior?: ScrollBehavior }): void
  autoscrollToBottom(): void
}

export const isAtListEnd = (element: HTMLElement, threshold: number) => element.scrollHeight - element.clientHeight - element.scrollTop <= threshold

/** 数据下标为 index 的已挂行(行根带 aria-posinset = 下标 + 1,见 MessageRow);没挂上 = null。 */
const rowAt = (content: HTMLElement, index: number) => content.querySelector<HTMLElement>(`:scope > [aria-posinset="${index + 1}"]`)

/** 把列表放到落点:最新一条贴底;锚点行的上沿离视口顶 -offset 像素(与滚动记忆离开时量的同一个矩形)。 */
export function placeAtLanding(scroller: HTMLElement, content: HTMLElement, landing: ListLanding): void {
  if (landing.index === 'LAST') { scroller.scrollTop = scroller.scrollHeight; return }
  const row = rowAt(content, landing.index)
  if (!row) { scroller.scrollTop = scroller.scrollHeight; return }
  scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + (landing.offset ?? 0)
}

/**
 * 一次挂载(resetKey)的滚动行为:落点、贴底跟随、在不在底部的电平、到顶回调、命令式句柄。
 * scroller / content 是文档流列表的滚动容器与内容层;landing 按挂载读一次(null = 落点未定,先按最新处放)。
 */
type Slice = { key: string | number | undefined; fromId: string | undefined; toId: string | undefined }
// 首帧那一段:最新处 = 最后几行;锚点 = 它上面一行起往下几行。toId 为空 = 一直到末尾(新消息照常接上)。
function firstSlice(key: Slice['key'], landing: ListLanding, ids: ReadonlyArray<string>): Slice {
  if (landing.index === 'LAST') return { key, fromId: ids[Math.max(0, ids.length - FIRST_FRAME_ROWS)], toId: undefined }
  return { key, fromId: ids[Math.min(ids.length - 1, Math.max(0, landing.index - 1))], toId: landing.index + FIRST_FRAME_ROWS >= ids.length - 1 ? undefined : ids[landing.index + FIRST_FRAME_ROWS] }
}

export function useFlowList({ scrollerRef, contentRef, resetKey, rowIds, landing, followTail, atBottomThreshold, onAtBottomChange, onTotalHeightChanged, onStartReached, handleRef }: {
  scrollerRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  resetKey: string | number | undefined
  /** 窗口里每一行的身份,按顺序。 */
  rowIds: ReadonlyArray<string>
  landing: ListLanding | null
  followTail: boolean
  atBottomThreshold: number
  onAtBottomChange?: (atBottom: boolean) => void
  onTotalHeightChanged?: () => void
  onStartReached?: () => void
  handleRef?: Ref<FlowListHandle>
}): { start: number; end: number } {
  const atBottomRef = useRef(true)
  const reportedRef = useRef<boolean | null>(null)
  const followRef = useRef(followTail)
  followRef.current = followTail
  const callbacksRef = useRef({ onAtBottomChange, onTotalHeightChanged, onStartReached })
  callbacksRef.current = { onAtBottomChange, onTotalHeightChanged, onStartReached }

  // 读者正看着的那一行与它离视口顶的距离;头部插行时按它放回原处。取上沿在视口里的第一行,且不取窗口第一行:
  // 前面接进消息后,原来的第一行会丢掉自己的日期/发言人头(矮三十多像素),钉它等于让它下面的内容整体上跳。
  const anchorRef = useRef<{ row: Element; top: number } | null>(null)
  const capture = useCallback((scroller: HTMLElement) => {
    const content = contentRef.current
    const view = scroller.getBoundingClientRect()
    const visible = content ? Array.from(content.children).filter((child) => { const r = child.getBoundingClientRect(); return r.bottom > view.top && r.top < view.bottom }) : []
    const row = visible.find((child) => child.getAttribute('aria-posinset') !== '1' && child.getBoundingClientRect().top >= view.top) ?? visible[0]
    anchorRef.current = row ? { row, top: row.getBoundingClientRect().top - view.top } : null
  }, [contentRef])

  const rangeRef = useRef({ key: resetKey, rowIds, start: 0, end: rowIds.length })
  const report = useCallback((scroller: HTMLElement) => {
    const range = rangeRef.current
    const atBottom = range.end === range.rowIds.length && isAtListEnd(scroller, atBottomThreshold)
    atBottomRef.current = atBottom
    if (reportedRef.current !== atBottom) {
      reportedRef.current = atBottom
      callbacksRef.current.onAtBottomChange?.(atBottom)
    }
  }, [atBottomThreshold])

  // 落点按挂载读一次 —— 调用方的落点在恢复落定后会变。
  const landingRef = useRef({ key: resetKey, landing })
  if (landingRef.current.key !== resetKey) { landingRef.current = { key: resetKey, landing }; reportedRef.current = null }
  const [slice, setSlice] = useState<Slice>(() => firstSlice(resetKey, landing ?? { index: 'LAST', align: 'end' }, rowIds))
  if (slice.key !== resetKey || (rowIds.length > 0 && slice.fromId === undefined)) setSlice(firstSlice(resetKey, landingRef.current.landing ?? { index: 'LAST', align: 'end' }, rowIds))
  const from = rowIds.indexOf(slice.fromId ?? '')
  const to = slice.toId === undefined ? -1 : rowIds.indexOf(slice.toId)
  const start = Math.max(0, from)
  const end = to < 0 ? rowIds.length : to + 1

  rangeRef.current = { key: resetKey, rowIds, start, end }
  const pending = useRef<{
    key: Slice['key']; id?: string; align: 'start' | 'center' | 'end'; offset: number; behavior?: ScrollBehavior
  } | null>(null)
  const paintedRef = useRef<Slice['key'] | null>(null)
  // 已挂区域也是真实文档流;只在边缘不足一屏时扩同一份 ID 切片,不估高、不加占位。
  const grow = useCallback((scroller: HTMLElement, top = scroller.scrollTop) => {
    const range = rangeRef.current
    const above = range.start > 0 && top < scroller.clientHeight
    const below = range.end < range.rowIds.length && scroller.scrollHeight - scroller.clientHeight - top < scroller.clientHeight
    if (!above && !below) return false
    setSlice(s => s.key !== range.key ? s : {
      ...s,
      fromId: above ? range.rowIds[Math.max(0, range.start - GROW_ROWS)] : s.fromId,
      toId: below ? range.end + GROW_ROWS >= range.rowIds.length ? undefined : range.rowIds[range.end - 1 + GROW_ROWS] : s.toId,
    })
    return true
  }, [])
  const headKey = rowIds[start]
  // @@@anchor-at-head-change - The anchor only matters when the window's head changes. This render is the last moment the old
  // rows are still on screen, so measure it here — once per head change — instead of on every scroll event.
  const dataHead = rowIds[0]
  const measuredHeadRef = useRef({ headKey, dataHead, key: resetKey })
  if (measuredHeadRef.current.headKey !== headKey || measuredHeadRef.current.dataHead !== dataHead) {
    const sameList = measuredHeadRef.current.key === resetKey
    const prepended = sameList && measuredHeadRef.current.dataHead !== dataHead
    measuredHeadRef.current = { headKey, dataHead, key: resetKey }
    const scroller = scrollerRef.current
    if (scroller && sameList) {
      capture(scroller)
      // 旧首行接上历史后会丢掉日期头;近顶时让新头和它在同次提交出现,避免负向补偿先被0夹住。
      if (prepended && start > 0 && scroller.scrollTop < scroller.clientHeight) {
        setSlice(s => ({ ...s, fromId: rowIds[Math.max(0, start - GROW_ROWS)] }))
      }
    }
  }

  // 头部插进一页旧消息(或窗口从头部裁掉几行):把读者正看着的那一行放回原处,在这次提交的绘制之前。
  // 浏览器的原生锚定多数时候已经做了(这里读到的差就是 0);它不管的是滚动条正好顶在 0 的时候,以及不支持锚定的 WebKit。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current, anchor = anchorRef.current
    if (!scroller || !anchor || !anchor.row.isConnected || (followRef.current && atBottomRef.current)) return
    const delta = anchor.row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
  }, [headKey, dataHead, scrollerRef])

  // 初次落点和未挂载目标都先补到真实行,在这次绘制前定位;没有请求时不再重放落点。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current, content = contentRef.current
    if (!scroller || !content || !rowIds.length) return
    const request = pending.current?.key === resetKey ? pending.current : null
    // 落点还在补行时来的请求(切过去的群当场定位一条消息)等落点放好再执行,❌ 不被落点盖掉、也不丢。
    const landing = paintedRef.current !== resetKey
    if (landing) {
      placeAtLanding(scroller, content, landingRef.current.landing ?? { index: 'LAST', align: 'end' })
      if (grow(scroller)) return
      paintedRef.current = resetKey
    }
    if (request) {
      if (request.id === undefined) {
        scroller.scrollTop = scroller.scrollHeight
        if (grow(scroller)) return
      } else {
        const index = rowIds.indexOf(request.id)
        const row = index < 0 ? null : rowAt(content, index)
        if (row) {
          const view = scroller.getBoundingClientRect(), rect = row.getBoundingClientRect()
          const top = scroller.scrollTop + rect.top - view.top
          const target = (request.align === 'start' ? top : request.align === 'end' ? top + rect.height - view.height : top + rect.height / 2 - view.height / 2) + request.offset
          if (grow(scroller, target)) return
          scroller.scrollTo({ top: target, behavior: request.behavior })
        }
      }
      pending.current = null
    } else if (!landing) {
      // 新行进来时保留旧贴底意图,先贴住再重算电平;否则会在 ResizeObserver 前把意图清掉。
      if (followRef.current && atBottomRef.current && end === rowIds.length) scroller.scrollTop = scroller.scrollHeight
      grow(scroller)
    }
    report(scroller)
  }, [resetKey, slice, rowIds, end, scrollerRef, contentRef, grow, report])

  // 内容长高/变矮:在底部就贴住(新消息、最后一条长高、图片晚到);ResizeObserver 在布局之后、绘制之前回调。
  // 不在底部时视口上方的变化交给浏览器的滚动锚定,这里不动。
  useEffect(() => {
    const scroller = scrollerRef.current, content = contentRef.current
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followRef.current && atBottomRef.current) scroller.scrollTop = scroller.scrollHeight
      callbacksRef.current.onTotalHeightChanged?.()
      report(scroller)
      grow(scroller)
    })
    observer.observe(content)
    const scrolled = afterPaint(() => {
      report(scroller)
      if (!grow(scroller) && rangeRef.current.start === 0 && scroller.scrollTop <= 120) callbacksRef.current.onStartReached?.()
    })
    scroller.addEventListener('scroll', scrolled.schedule, { passive: true })
    return () => { observer.disconnect(); scroller.removeEventListener('scroll', scrolled.schedule); scrolled.cancel() }
  }, [resetKey, scrollerRef, contentRef, report, grow])

  // 原生全选发生之前补齐同一数据窗口;不接管选区/复制,也不处理输入框或其它面板的快捷键。
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const selectAll = (event: Event) => {
      if (event.type === 'keydown') {
        const key = event as KeyboardEvent
        if (!(key.metaKey || key.ctrlKey) || key.altKey || key.shiftKey || key.key.toLowerCase() !== 'a') return
      }
      if ((event.target as Element | null)?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return
      const range = rangeRef.current
      if (range.start === 0 && range.end === range.rowIds.length) return
      flushSync(() => setSlice(s => ({ ...s, fromId: range.rowIds[0], toId: undefined })))
    }
    scroller.addEventListener('keydown', selectAll)
    scroller.addEventListener(PREPARE_SELECT_ALL_EVENT, selectAll)
    return () => { scroller.removeEventListener('keydown', selectAll); scroller.removeEventListener(PREPARE_SELECT_ALL_EVENT, selectAll) }
  }, [resetKey, scrollerRef])

  useImperativeHandle(handleRef, () => ({
    scrollToIndex: ({ index, align = 'start', offset = 0, behavior }) => {
      const range = rangeRef.current
      const id = range.rowIds[index]
      if (!id) return
      pending.current = { key: range.key, id, align, offset, behavior }
      setSlice(s => ({ ...s,
        fromId: range.rowIds[Math.min(range.start, Math.max(0, index - FIRST_FRAME_ROWS))],
        toId: index >= range.end ? index + FIRST_FRAME_ROWS >= range.rowIds.length ? undefined : range.rowIds[index + FIRST_FRAME_ROWS] : s.toId,
      }))
    },
    autoscrollToBottom: () => {
      const range = rangeRef.current
      pending.current = { key: range.key, align: 'end', offset: 0 }
      setSlice(s => ({ ...s, toId: undefined }))
    },
  }), [])
  return { start, end }
}
