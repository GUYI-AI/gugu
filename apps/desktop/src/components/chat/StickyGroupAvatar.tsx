import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** 组首那条消息的头像占位带这个标记;组尾的头像层往上找到它为止。 */
const GROUP_TOP_ATTR = 'data-avatar-group-top'

type AvatarBounds = { layer: HTMLDivElement; bottom: number; height: number }
type AvatarMeasure = { row: Element; read: () => AvatarBounds | undefined }
const avatarMeasures = new Map<Element, Set<AvatarMeasure>>()
// Rows are content-visibility:auto once laid out. Reading a bubble in a skipped row forces that row's layout, once per row,
// and a skipped row paints nothing, so its layer waits for the row's unskip event instead. Unknown state counts as shown.
const skippedRows = new WeakSet<Element>()
const waitingRows = new Map<Element, Set<AvatarMeasure>>()
const skipWatchedLists = new WeakSet<Element>()
let avatarResize: ResizeObserver | undefined

function applyAvatarMeasures(measures: Iterable<AvatarMeasure>) {
  // Like BubbleSender's owner-fit observer, read every affected row before writing any styles, including across lists.
  const bounds = [...measures].map(measure => measure.read())
  for (const box of bounds) {
    if (!box) continue
    box.layer.style.bottom = `${box.bottom}px`
    box.layer.style.height = `${box.height}px`
  }
}

function avatarResizeObserver(): ResizeObserver {
  return avatarResize ??= new ResizeObserver((entries) => {
    const measures = new Set<AvatarMeasure>()
    for (const { target } of entries) {
      for (const measure of avatarMeasures.get(target) ?? []) {
        if (!skippedRows.has(measure.row)) { measures.add(measure); continue }
        const waiting = waitingRows.get(measure.row) ?? new Set<AvatarMeasure>()
        waitingRows.set(measure.row, waiting.add(measure))
      }
    }
    applyAvatarMeasures(measures)
  })
}

function watchRowSkips(list: Element) {
  if (skipWatchedLists.has(list)) return
  skipWatchedLists.add(list)
  // The event does not bubble; a capture listener on the list sees every row's.
  list.addEventListener('contentvisibilityautostatechange', (event) => {
    const row = event.target as Element
    if ((event as Event & { skipped?: boolean }).skipped) { skippedRows.add(row); return }
    skippedRows.delete(row)
    const waiting = waitingRows.get(row)
    if (!waiting) return
    waitingRows.delete(row)
    applyAvatarMeasures(waiting)
  }, true)
}

/**
 * 消息行的头像那一列(owner 10-25,照 Telegram Web 的 .bubbles-group-avatar):头像画在一组连续消息的最后一条旁边,
 * 组里其余几条只留同宽的占位。最后一条那里套一层从组首气泡上沿伸到这条气泡下沿的绝对定位层,头像在层里
 * position:sticky 贴着输入坞上沿(没有浮动坞时是消息滚动区的底边):组尾在视口下面时头像停在视口底、跟着滚,直到组首滚出去;
 * 头像永远不越出自己这组气泡的纵向范围。行是文档流里的兄弟节点、没有组容器,层的上下沿在布局后量。
 */
export function GroupAvatarSlot({ wide, groupedWithPrev, groupedWithNext, children }: { wide: boolean; groupedWithPrev: boolean; groupedWithNext: boolean; children: ReactNode }) {
  const width = wide ? 'w-[44px]' : 'w-[32px]' // 手机 44(触控目标)、桌面 32,与头像按钮同宽
  if (groupedWithNext) return <div aria-hidden="true" {...(groupedWithPrev ? {} : { [GROUP_TOP_ATTR]: '' })} className={`${width} shrink-0`} />
  return <StickyGroupAvatar width={width} continuesGroup={groupedWithPrev}>{children}</StickyGroupAvatar>
}

function StickyGroupAvatar({ width, continuesGroup, children }: { width: string; continuesGroup: boolean; children: ReactNode }) {
  const slotRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const slot = slotRef.current, layer = layerRef.current
    const row = slot?.closest('[role="listitem"]')
    const list = row?.parentElement
    if (!slot || !layer || !row || !list) return
    const read = () => {
      // 一条成组的消息,组首就是自己这一行 ⇒ 不往上找(往上找会落到上一组的组首,层伸进别的组)。
      let top: Element | null = null
      let firstMounted = row
      for (let r = continuesGroup ? row.previousElementSibling : null; r && !top; r = r.previousElementSibling) {
        firstMounted = r
        top = r.querySelector(`[${GROUP_TOP_ATTR}]`)
      }
      // 层的上下沿 = 组首那条气泡的上沿、这一条气泡的下沿:名字/时间行、表情回应都不算。
      const bubble = (r: Element) => r.querySelector('[data-message-bubble-row]')?.getBoundingClientRect()
      const own = bubble(row), first = bubble(top?.closest('[role="listitem"]') ?? firstMounted), box = slot.getBoundingClientRect()
      if (!own || !first) return
      return { layer, bottom: box.bottom - own.bottom, height: own.bottom - first.top }
    }
    const measure: AvatarMeasure = { row, read }
    watchRowSkips(list)
    // The first delivery still measures after layout and before paint, without a synchronous mid-commit read.
    const observer = avatarResizeObserver()
    // A new tail row needs its first notification even when the list's dimensions stay unchanged.
    const targets = [list, row].map(target => {
      const measures = avatarMeasures.get(target) ?? new Set<AvatarMeasure>()
      if (!avatarMeasures.has(target)) { avatarMeasures.set(target, measures); observer.observe(target) }
      measures.add(measure)
      return { target, measures }
    })
    return () => {
      const waiting = waitingRows.get(row)
      if (waiting?.delete(measure) && !waiting.size) waitingRows.delete(row)
      for (const { target, measures } of targets) {
        measures.delete(measure)
        if (!measures.size) { avatarMeasures.delete(target); observer.unobserve(target) }
      }
    }
  }, [continuesGroup])
  return (
    <div ref={slotRef} className={`${width} relative shrink-0 self-stretch`}>
      <div ref={layerRef} className="pointer-events-none absolute inset-x-0 flex flex-col justify-end">
        <div data-chat-dock-reads="" className="pointer-events-auto sticky bottom-[calc(var(--chat-dock-avatar-h,0px)+var(--spacing)*1.5)]">{children}</div>
      </div>
    </div>
  )
}
