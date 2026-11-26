import { useContext, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AvatarTrackContext, ROW_BODY_ATTR } from './avatarTrack'

/** 组首那条消息的头像占位带这个标记;组尾的头像轨道往上找到它为止。 */
const GROUP_TOP_ATTR = 'data-avatar-group-top'
/**
 * @@@avatar-track (avatarTrack.ts) — the avatar stays in the bubble's React tree (a portal onto its row's track), so clicks,
 * the context-menu @, the profile card and the focus / reading order (the avatar just before its bubble) are what they were.
 * The track is absolute at its static place (the row's top-left) and moved by margins, so it scrolls with its row because
 * the list's rows box is positioned (MessageList).
 */
type Bubble = { top: number; bottom: number }
type Track = {
  track: HTMLDivElement
  gutter: HTMLDivElement
  row: Element
  list: Element
  continuesGroup: boolean
  rows?: Element[]
  rowsAt: number
}

// ── which rows are awake (only from contentvisibilityautostatechange; a row that never reported is awake) ─────────────
const skippedRows = new WeakSet<Element>()
const listGenerations = new WeakMap<Element, number>()
const tracksByList = new Map<Element, Set<Track>>()
/** A row's bubble, relative to the row's top: read while the row is awake, used while it is skipped. */
const bubbleInRow = new WeakMap<Element, Bubble>()
let avatarResize: ResizeObserver | undefined

/** The rows a track spans, from its own row up to the group's first; only the list's DOM changes them. */
function groupRows(entry: Track): Element[] {
  const generation = listGenerations.get(entry.list) ?? 0
  if (entry.rows && entry.rowsAt === generation) return entry.rows
  const rows = [entry.row]
  // 一条成组的消息,组首就是自己这一行 ⇒ 不往上找(往上找会落到上一组的组首,层伸进别的组)。
  for (let row = entry.continuesGroup ? entry.row.previousElementSibling : null; row; row = row.previousElementSibling) {
    rows.push(row)
    if (row.querySelector(`[${GROUP_TOP_ATTR}]`)) break
  }
  entry.rows = rows
  entry.rowsAt = generation
  return rows
}

const awake = (entry: Track) => groupRows(entry).some(row => !skippedRows.has(row))

function bubbleOf(row: Element, rowTop: number): Bubble | undefined {
  if (!skippedRows.has(row)) {
    const box = row.querySelector('[data-message-bubble-row]')?.getBoundingClientRect()
    if (box) bubbleInRow.set(row, { top: box.top - rowTop, bottom: box.bottom - rowTop })
  }
  return bubbleInRow.get(row)
}

/**
 * The track spans the group's first bubble's top to this row's bubble's bottom, at the gutter's x. Only awake groups are
 * read: a group whose every row is skipped is off screen with its margin, and so is all of its avatar. Every read comes
 * before any write, across lists (like BubbleSender's owner-fit observer).
 */
function placeTracks(entries: Iterable<Track>) {
  const boxes = [...entries].filter(awake).map((entry) => {
    const rows = groupRows(entry)
    const rowBox = entry.row.getBoundingClientRect()
    const first = rows.at(-1)!
    const firstTop = first === entry.row ? rowBox.top : first.getBoundingClientRect().top
    const own = bubbleOf(entry.row, rowBox.top), top = bubbleOf(first, firstTop), gutter = entry.gutter.getBoundingClientRect()
    if (!own || !top) return null
    // The track sits at its static place (the row's top-left); margins move it onto the gutter and up to the first bubble.
    return { track: entry.track, x: gutter.left - rowBox.left, width: gutter.width, up: rowBox.top - (firstTop + top.top), height: own.bottom + rowBox.top - (firstTop + top.top) }
  })
  for (const box of boxes) {
    if (!box) continue
    box.track.style.marginLeft = `${box.x}px`
    box.track.style.width = `${box.width}px`
    box.track.style.marginTop = `${-box.up}px`
    box.track.style.height = `${box.height}px`
  }
}

/** One observer for every list: a list's size changes with a fold, a resize or a row that grows; a new track reports once. */
function avatarResizeObserver(): ResizeObserver {
  return avatarResize ??= new ResizeObserver((entries) => {
    const due = new Set<Track>()
    for (const { target } of entries) {
      for (const entry of tracksByList.get(target) ?? []) due.add(entry)
      const own = (target as HTMLElement).dataset.avatarTrack !== undefined ? trackEntries.get(target) : undefined
      if (own) { due.add(own); avatarResize!.unobserve(target) }
    }
    placeTracks(due)
  })
}
const trackEntries = new WeakMap<Element, Track>()

function watchList(list: Element) {
  if (listGenerations.has(list)) return
  listGenerations.set(list, 0)
  // Which rows a group spans changes only with the list's DOM (a row added, removed, regrouped).
  new MutationObserver(() => listGenerations.set(list, (listGenerations.get(list) ?? 0) + 1))
    .observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: [GROUP_TOP_ATTR] })
  // The event does not bubble; a capture listener on the list sees every row body's. Only the body's own state counts:
  // content inside a bubble can be content-visibility:auto too (streamdown's code block), and its skip says nothing about the row.
  list.addEventListener('contentvisibilityautostatechange', (event) => {
    if (!(event.target as Element).hasAttribute(ROW_BODY_ATTR)) return
    const row = (event.target as Element).parentElement
    if (!row) return
    if ((event as Event & { skipped?: boolean }).skipped) { skippedRows.add(row); return }
    skippedRows.delete(row)
    // A row comes back: the groups it belongs to are drawn again from here (its bubble is read now that it is awake).
    placeTracks([...tracksByList.get(list) ?? []].filter(entry => groupRows(entry).includes(row)))
  }, true)
}

/**
 * 消息行的头像那一列(owner 10-25,照 Telegram Web 的 .bubbles-group-avatar):头像画在一组连续消息的最后一条旁边,
 * 组里其余几条只留同宽的占位。组尾那条的头像画在这一行的轨道上(@@@avatar-track),轨道从组首气泡上沿伸到这条气泡下沿,
 * 头像在轨道里 position:sticky 贴着输入坞上沿(没有浮动坞时是消息滚动区的底边):组尾在视口下面时头像停在视口底、跟着滚,
 * 直到组首滚出去;头像永远不越出自己这组气泡的纵向范围。行是文档流里的兄弟节点、没有组容器,轨道的上下沿在布局后量。
 */
export function GroupAvatarSlot({ wide, groupedWithPrev, groupedWithNext, children }: { wide: boolean; groupedWithPrev: boolean; groupedWithNext: boolean; children: ReactNode }) {
  const width = wide ? 'w-[var(--msg-avatar-gutter-touch)]' : 'w-[var(--msg-avatar-gutter)]' // tokens.css:手机触控目标、桌面与头像按钮同宽
  if (groupedWithNext) return <div aria-hidden="true" {...(groupedWithPrev ? {} : { [GROUP_TOP_ATTR]: '' })} className={`${width} shrink-0`} />
  return <StickyGroupAvatar width={width} continuesGroup={groupedWithPrev}>{children}</StickyGroupAvatar>
}

function StickyGroupAvatar({ width, continuesGroup, children }: { width: string; continuesGroup: boolean; children: ReactNode }) {
  const host = useContext(AvatarTrackContext)
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const track = host?.track ?? null, want = host?.want
  useLayoutEffect(() => { if (!want) return; want(true); return () => want(false) }, [want])
  useLayoutEffect(() => {
    const gutter = gutterRef.current, row = track?.parentElement, list = row?.parentElement
    if (!track || !gutter || !row || !list) return
    const entry: Track = { track, gutter, row, list, continuesGroup, rowsAt: -1 }
    watchList(list)
    const entries = tracksByList.get(list) ?? new Set<Track>()
    const observer = avatarResizeObserver()
    if (!tracksByList.has(list)) { tracksByList.set(list, entries); observer.observe(list) }
    entries.add(entry)
    // The first placement comes with the observer's delivery after layout, before paint, ❌ a synchronous mid-commit read.
    trackEntries.set(track, entry)
    observer.observe(track)
    return () => {
      entries.delete(entry)
      observer.unobserve(track)
      if (!entries.size) { tracksByList.delete(list); observer.unobserve(list) }
    }
  }, [track, continuesGroup])
  // A bubble drawn on its own (no MessageRow: a preview, a test) has no group to span: its avatar sits in its gutter.
  if (!host) return <div className={`${width} shrink-0`}>{children}</div>
  return (
    <>
      <div ref={gutterRef} className={`${width} shrink-0 self-stretch`} />
      {track && createPortal(
        <div data-chat-dock-reads="" className="pointer-events-auto sticky bottom-[calc(var(--chat-dock-avatar-h,0px)+var(--spacing)*1.5)]">{children}</div>,
        track,
      )}
    </>
  )
}
