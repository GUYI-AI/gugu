import type { QuoteSelection } from './messageQuoteContent'
import type { ReadReceiptHandle } from '@/hooks/useReadReceiptPanel'
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createSelectStore, sameShallow, useSelect, type SelectStore } from '@/lib/selectStore'
import { useAppActive } from '@/lib/onScreenChat'
import type { CSSProperties, MouseEvent, ReactNode, Ref } from 'react'
import type { MessageItem, MessageSendState, TopicSummary } from '@gugu/core/shared/types/chat'
import type { HeldMessage } from '@gugu/core/shared/ui/systemNotice'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { computeGroupedWithPrev } from '@gugu/core/shared/ui/messageListModels'
import { deriveMessageSendState, deriveReadReceipt, type MessageRecipientFacts } from '@gugu/core/shared/ui/messageState'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { OPEN_AT_LATEST, useRowAboveViewport } from '@/lib/listLanding'
import { useFlowList, type FlowListHandle, type ListLanding } from '@/lib/flowList'
import { formatCalendarDay } from '@/i18n/format'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import type { MemberProfileOpener } from '../memberProfileModels'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { MessageRow } from './MessageRow'
import { MessageSenderProvider } from './MessageSenderProvider'
import { MessageBubble } from './MessageBubble'
import { AgentFloodSystemNotice } from './AgentFloodSystemNotice'
import { MemberJoinNotice, type MentionTarget } from '../groups/MemberJoinNotice'
import { parseSystemNotice } from '@gugu/core/shared/ui/systemNotice'
import { TopicAnchorCard } from './TopicAnchorCard'
import { shouldShowTimeDivider } from './messageRowTime'
import { TaskExchangeBubble } from '../assistant/TaskExchangeBubble'
import { visibleReplyQuoteIds } from './replyQuoteVisibility'
import { MESSAGE_SEEN_THRESHOLDS, messageSeen } from './messageSeen'
import { useStructurallyShared } from '@/hooks/useStructurallyShared'
import { collapseSendGroups, newestDelivered, sameAlbums } from './messageAlbum'
import { MessageAlbumContext } from './MessageAlbumContext'

// #1163 perf — 在父层为单条消息预算「发送/已读态」(primitive 字符串)，下传给 memo 化的 MessageBubble，
// 取代旧的「整个 memberReadSeqs map 下传、气泡自己 derive」。任一成员已读回执会换 map 引用、破气泡浅比较
// memo → 全群可视气泡重渲；改传 primitive 后，只有本消息状态真翻转时气泡才重渲。仅 is_mine 非撤回消息需要。
function computeSendState(msg: MessageItem, memberReadSeqs: Record<string, number>, facts: MessageRecipientFacts): MessageSendState | undefined {
  if (!msg.is_mine || msg.retracted_at) return undefined
  return deriveMessageSendState(msg, memberReadSeqs, facts, {
    // @@@per-message-read (#598) - precise directed read receipts, decoupled from the watermark.
    // memberIds = current OTHER members (so a recipient who left drops out of the denominator).
    memberIds: Object.keys(memberReadSeqs),
    messageReaders: msg.readers && msg.readers.length ? { [msg.id]: new Set(msg.readers) } : {},
  })
}

// @@@1313 逐成员读回执（水位派生）：父层预算「已读 N · 未读 M」/ 私聊「已读」「未读」primitive 字符串
// 下传气泡（同 computeSendState 的 memo 策略——别传整个 memberReadSeqs map）。仅本人已发(非撤回/非发送中)。
// @@@1345 已读回执进度圆环：父层预算「已读数 / 收件总数」两个 primitive 下传(memo 安全)，气泡渲染环；
// 标签(已读/未读 文案)与环填充都由 read/total 在气泡侧派生(total===1 私聊 / total>1 群聊)。
function computeReadReceipt(
  msg: MessageItem,
  memberReadSeqs: Record<string, number>,
  facts: MessageRecipientFacts,
): { read: number; total: number } | undefined {
  if (!msg.is_mine || msg.retracted_at || msg.seq < 0 || msg.local_send_state === 'sending' || msg.local_send_state === 'failed') {
    return undefined
  }
  const receipt = deriveReadReceipt(msg, memberReadSeqs, facts, {
    messageReaders: msg.readers && msg.readers.length ? { [msg.id]: new Set(msg.readers) } : {},
  })
  if (!receipt || receipt.totalRecipients === 0) return undefined // 无其他收件方（自言自语/空群）→ 不显
  return { read: receipt.readCount, total: receipt.totalRecipients }
}

// @@@multi-select (#988) — 多选行首勾选框，沿用 ForwardMessageDialog 的圆形勾选样式（--accent / --accent-tint-row）。


/**
 * 主时间线的消息列表。@@@5856 从 ChatAreaPanel 里**抽出来**的,不是新写的一份:
 * 话题分栏原先自己撸了一个 map + 手写贴底,owner 2026-09-19 实测的原话是
 * 「发的新消息和收到的新消息,消息列表居然不会滚动,我怀疑消息列表你也是自己 vibe 没有复用.应该复用」。
 *
 * 他说对了。这个列表难的不是把消息画出来,是滚动:首屏钉底要等 markdown/代码块异步撑高、
 * 快速上滚时 atBottom 的 ref 会 stale、prepend 旧页不许把视口拽回底、Virtuoso 自己的
 * autoscroll 在某些平台还会差一截。这些 #461 / #667 / #780 / #781 / #1315 一路踩过来的东西,
 * 自己撸一个 map 全都没有 —— 症状就是「不会滚」。
 */
function withoutLiveStatus(profiles: Record<string, MemberProfileCardModel>): Record<string, MemberProfileCardModel> {
  const out: Record<string, MemberProfileCardModel> = {}
  for (const [id, { agentStatus: _status, agentMeta: _meta, ...rest }] of Object.entries(profiles)) out[id] = rest
  return out
}

// ── MessageListRow ────────────────────────────────────────────────────────────
// Module-level so row rendering stays stable across ChatAreaPanel re-renders;
// unrelated header/input state changes should not remount visible message rows.

export interface MessageListRowProps {
  rows: ChatListRowItem[]
  messages: MessageItem[]
  mobile: boolean
  /** #1708 命中「来源消息跳转」时高亮闪烁的消息 id。 */
  flashMessageId: string | null | undefined
  memberReadSeqs: Record<string, number>
  /** My messages an agent has not taken yet (useMessageDelivery): their bubbles say so until it reads them. */
  deliveryWaits: ReadonlyMap<string, HeldMessage>
  /** Who each of my messages is for (useMessageDelivery): denominators of its read receipt. */
  recipientFacts: MessageRecipientFacts
  // 私聊/AI 没有 thread surface；群聊 thread 由右侧 panel 承载。
  isGroupChat: boolean
  threeParty: boolean | undefined
  memberProfiles: Record<string, MemberProfileCardModel>
  onReaction: (messageId: string, emoji: string) => void
  // @@@1345 已读圆环是父层「谁已读/谁未读」名单的 Trigger(稳定 handle，避免 reader 列表作对象 prop 破 memo)。
  readReceiptHandle: ReadReceiptHandle | undefined
  onShowMessage?: (id: string) => void
  onQuote: (msg: MessageItem, selection?: QuoteSelection) => void
  /** A send of several files is forwarded whole (#2581). */
  onForward: (msg: MessageItem | readonly MessageItem[]) => void
  onDelete: (messageId: string) => void
  onVisible: (msg: MessageItem) => void
  memberProfileOpener: MemberProfileOpener | undefined
  // @@@5856 开话题(从本消息长出一条线)+ 本消息底下已有的话题锚点卡。锚点是溯源不是父容器:
  // 卡片只是双向连接的一端,话题本身在会话列表里缩进挂在来源那条线底下。
  onOpenTopic: ((messageId: string) => void) | undefined
  topicAnchors: ReadonlyMap<string, TopicSummary[]> | undefined
  onOpenTopicAnchor: ((topicChatId: string) => void) | undefined
  /** 这条线上「agent 超过 5 个已自动转 passive」的那条系统消息(每条线至多一条)。 */
  agentFloodNoticeMessageId: string | null | undefined
  onAgentFloodUndone: (() => void) | undefined
  onOpenFile: ((meta: ParsedAttachment, message?: MessageItem) => void) | undefined
  onMentionMember: ((target: MentionTarget) => void) | undefined // @@@6386 入群灰字里点名字 → 输入框插 @
  // @@@multi-select (#988) — 多选态：行首勾选框 + 整行点击切换选中；onEnterSelectMode 透传给气泡「多选」菜单项。
  selectMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (messageId: string) => void
  onEnterSelectMode: ((msg: MessageItem) => void) | undefined
}

// @@@2186 — 主时间线 rows 只有消息行。#1671 后 in-list 运行态改由 composer 上方浮动条统一显示，曾经的
// agentActivity 行渲染恒为 null——一个零高的 virtuoso 行，agent 运行期间每次行测量都对它报一条
// "react-virtuoso: Zero-sized element" console error（#2186），故该行类型随 #1671 的契约一并移除。
export type ChatListRowItem = { type: 'message'; message: MessageItem } | { type: 'task-exchange'; message: MessageItem; recipientUserId: string }

const SelectionCheckbox = ({ checked }: { checked: boolean }) => (
  <div
    aria-checked={checked}
    role="checkbox"
    style={{
      width: 18,
      height: 18,
      borderRadius: 'var(--radius-circle)',
      flexShrink: 0,
      border: checked ? '2px solid var(--accent)' : '2px solid var(--border-subtle)',
      background: checked ? 'var(--accent)' : 'var(--bg-transparent)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background var(--transition-fast), color var(--transition-fast)',
    }}
  >
    {checked && (
      <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
        <path d="M1 4l3 3 5-6" stroke="var(--surface-white)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )}
  </div>
)
const SELECT_ROW_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', cursor: 'pointer' }
const SELECT_BUBBLE_STYLE: CSSProperties = { flex: 1, minWidth: 0, pointerEvents: 'none' }
type Handlers = Pick<MessageListRowProps, 'onReaction' | 'onQuote' | 'onForward' | 'onDelete' | 'onToggleSelect'> & {
  onVisible: (msg: MessageItem) => void
  /** Read at the moment of a click: a selection change re-renders the rows it flips, not the album's other files. */
  isSelected: (messageId: string) => boolean
  onShowMessage?: (id: string) => void
  onOpenTopic?: (messageId: string) => void
  onOpenTopicAnchor?: (topicChatId: string) => void
  onAgentFloodUndone?: () => void
  onOpenFile?: (meta: ParsedAttachment, message?: MessageItem) => void
  onMentionMember?: (target: MentionTarget) => void
  onEnterSelectMode?: (msg: MessageItem) => void
}
type OptionalHandler = 'onShowMessage' | 'onOpenTopic' | 'onOpenTopicAnchor' | 'onAgentFloodUndone' | 'onOpenFile' | 'onMentionMember' | 'onEnterSelectMode'
const OPTIONAL_HANDLERS: readonly OptionalHandler[] = ['onShowMessage', 'onOpenTopic', 'onOpenTopicAnchor', 'onAgentFloodUndone', 'onOpenFile', 'onMentionMember', 'onEnterSelectMode']

/** What one row draws. Every field is a primitive or a reference that only changes when this row's message changes. */
type RowView = {
  msg: MessageItem
  /** Set for a task-exchange row: whom the exchange was for. */
  taskRecipient: string | undefined
  album: readonly MessageItem[] | undefined
  showReplyQuote: boolean
  showTimeDivider: boolean
  groupedWithPrev: boolean
  groupedWithNext: boolean
  sendState: MessageSendState | undefined
  undeliveredTo: string | undefined
  readReceiptRead: number | undefined
  readReceiptTotal: number | undefined
  memberProfile: MemberProfileCardModel | null
  selected: boolean
  anchoredTopics: TopicSummary[] | undefined
  agentFloodNotice: boolean
}
/** What every row of the list shares; changes re-render every row, so only list-wide settings go here. */
type ListShared = {
  mobile: boolean
  isGroupChat: boolean
  threeParty: boolean | undefined
  selectMode: boolean
  bubbleMemberProfiles: Record<string, MemberProfileCardModel>
  readReceiptHandle: ReadReceiptHandle | undefined
  memberProfileOpener: MemberProfileOpener | undefined
  handlers: Handlers
}
type ListView = { rows: ReadonlyMap<string, RowView>; shared: ListShared }

// @@@row-by-id - a row is handed its id only and selects its own view from the list's store (@@@select-store). The list
// derives every row's view in one pass and keeps the previous view object of a row whose fields did not change, so a
// message arriving, a read receipt or a member's status re-renders the rows it concerns, not every mounted row.
const RowStoreContext = createContext<SelectStore<ListView> | null>(null)

function rowViewsOf(rows: readonly ChatListRowItem[], props: MessageListRowProps, albums: ReadonlyMap<string, readonly MessageItem[]>, quoteIds: ReadonlySet<string>, previous: ReadonlyMap<string, RowView>): Map<string, RowView> {
  const views = new Map<string, RowView>()
  rows.forEach((row, index) => {
    const msg = row.message
    const album = albums.get(msg.id)
    const counted = album ? { ...msg, seq: newestDelivered(album).seq } : msg // read as far as its last file
    const readReceipt = computeReadReceipt(counted, props.memberReadSeqs, props.recipientFacts) // @@@1577 M5 A6 — 单次派生
    const prevRow = index > 0 ? rows[index - 1] : undefined
    const nextRow = rows[index + 1]
    // 连续消息合组：同一发送者、无时间分隔线切断、双方都是普通消息时，后续消息隐藏头像+名字/时间行，
    // 只留气泡（间距也收紧）。whisper 形态特殊，不参与合组。
    const showTimeDivider = shouldShowTimeDivider(props.messages, index)
    const prevMsg = prevRow?.type === 'message' ? prevRow.message : null
    const view: RowView = {
      msg,
      taskRecipient: row.type === 'task-exchange' ? row.recipientUserId : undefined,
      album,
      showReplyQuote: quoteIds.has(msg.id),
      showTimeDivider,
      groupedWithPrev: computeGroupedWithPrev({ showTimeDivider, prevMsg, msg, prevIsThreadRoot: false }),
      groupedWithNext: nextRow?.type === 'message' && computeGroupedWithPrev({ showTimeDivider: shouldShowTimeDivider(props.messages, index + 1), prevMsg: msg, msg: nextRow.message, prevIsThreadRoot: false }),
      sendState: computeSendState(counted, props.memberReadSeqs, props.recipientFacts),
      undeliveredTo: props.deliveryWaits.get(msg.id)?.undeliveredTo.join(','),
      readReceiptRead: readReceipt?.read,
      readReceiptTotal: readReceipt?.total,
      memberProfile: msg.sender_user_id === null ? null : (props.memberProfiles[msg.sender_user_id] ?? null), // @@@2051 null=注销,无档、非 agent
      selected: props.selectedIds.has(msg.id),
      anchoredTopics: props.topicAnchors?.get(msg.id),
      // @@@5856 自动调档那条系统消息用专门的版式渲染:居中、说清改了哪几个、就地一键全撤。
      agentFloodNotice: msg.id === props.agentFloodNoticeMessageId && msg.content_type === 'system',
    }
    const before = previous.get(msg.id)
    views.set(msg.id, before && sameShallow(before, view) ? before : view)
  })
  return views
}

/** Reported as seen while its row intersects the scroller; called again when the window comes back to the front. */
type SeenRows = Map<string, () => void>

const MessageListRow = memo(function MessageListRow({ id, seenRows }: { id: string; seenRows: SeenRows }) {
  const store = useContext(RowStoreContext)!
  const view = useSelect(store, (list) => list.rows.get(id), Object.is)
  const shared = useSelect(store, (list) => list.shared, Object.is)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const { handlers } = shared
  const album = view?.album
  // #2581 A send of several files is one row: it is read when its last file is, and selected, deleted, forwarded whole.
  const whole = useMemo(() => album && {
    newest: newestDelivered(album),
    toggle: (selected: boolean) => { for (const member of album) if (handlers.isSelected(member.id) === selected) handlers.onToggleSelect(member.id) },
    enterSelectMode: handlers.onEnterSelectMode && ((msg: MessageItem) => { handlers.onEnterSelectMode!(msg); for (const member of album) if (member.id !== msg.id) handlers.onToggleSelect(member.id) }),
    forward: () => handlers.onForward(album),
    delete: () => { for (const member of album) handlers.onDelete(member.id) },
  }, [album, handlers])
  const reported = !view || view.taskRecipient !== undefined ? null : (whole?.newest ?? view.msg)

  useEffect(() => {
    const node = anchorRef.current?.closest<HTMLElement>('[data-msg-id]')
    if (!reported || !node) return
    const report = () => handlers.onVisible(reported)
    if (typeof IntersectionObserver === 'undefined') {
      seenRows.set(id, report)
      report()
      return () => { seenRows.delete(id) }
    }
    // Measured against the message scroller, so "fills the view" means the chat column, not the window.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(messageSeen)) {
        seenRows.set(id, report)
        report()
      } else seenRows.delete(id)
    }, { root: node.closest<HTMLElement>('[data-unread-stream-surface]'), threshold: [...MESSAGE_SEEN_THRESHOLDS] })
    observer.observe(node)
    return () => { observer.disconnect(); seenRows.delete(id) }
  }, [handlers, id, reported, seenRows])

  // @@@virtuoso-oob-guard (#461) - 行由 rows.slice 给出、不会越界;这一行只为收窄类型。
  if (!view) return null
  const { msg, memberProfile, selected: isSelected } = view
  const { isGroupChat, selectMode, bubbleMemberProfiles } = shared
  const notice = parseSystemNotice(msg) // @@@6386 服务端落的「X 加入了群聊」;回合失败那种由气泡里的 SystemMessageNotice 画
  // 右键群聊里的发送者头像 → 输入框 @ 他:与点运行中头像同一条插入链路;能 @ 谁同入群灰字(在群、不是自己)。
  const mentionFromAvatar = (event: MouseEvent<HTMLDivElement>) => {
    if (!isGroupChat || !handlers.onMentionMember || !memberProfile || msg.is_mine || memberProfile.membership === 'former') return
    if (!(event.target as Element).closest('[data-message-sender-id]')) return
    event.preventDefault()
    handlers.onMentionMember({ id: memberProfile.id, name: memberProfile.displayName })
  }
  const bubble = (
    <MessageSenderProvider message={msg} group={isGroupChat}>
    <MessageBubble
      msg={msg}
      showReplyQuote={view.showReplyQuote}
      onReaction={handlers.onReaction}
      sendState={view.sendState}
      undeliveredTo={view.undeliveredTo}
      readReceiptRead={view.readReceiptRead}
      readReceiptTotal={view.readReceiptTotal}
      // #2098 owner 定:已读回执逐条显示(每条本人消息都挂环),非只末条。气泡内已按 is_mine + read>0 门控。
      showReadReceipt={msg.is_mine}
      groupedWithPrev={view.groupedWithPrev}
      groupedWithNext={view.groupedWithNext}
      readReceiptHandle={shared.readReceiptHandle}
      onQuote={handlers.onQuote} onShowMessage={handlers.onShowMessage}
      onForward={whole?.forward ?? handlers.onForward}
      onDelete={whole?.delete ?? handlers.onDelete}
      isAgent={memberProfile?.type === 'agent'}
      isGroup={isGroupChat || shared.threeParty}
      // 场所型会话里的 agent 消息保留发送者头像
      memberProfile={memberProfile}
      memberProfileOpener={shared.memberProfileOpener}
      compactMobile={shared.mobile}
      // 直接透传稳定 handler；话题里不传则不显示「开话题」菜单项(单层不嵌套)。
      onOpenTopic={handlers.onOpenTopic} onOpenTopicAnchor={msg.content_type === 'system' ? handlers.onOpenTopicAnchor : undefined} onOpenFile={handlers.onOpenFile}
      memberProfiles={bubbleMemberProfiles}
      // @@@multi-select (#988) — More 菜单「多选」入口;多选态的勾选/底色在外层处理。
      onEnterSelectMode={whole ? whole.enterSelectMode : handlers.onEnterSelectMode}
    />
    </MessageSenderProvider>
  )

  return (
    // The row element itself (MessageRow) is drawn by the list: its position and flash change without this row's view.
    <div ref={anchorRef} style={ROW_CONTENTS_STYLE} onContextMenu={mentionFromAvatar}>
      {view.showTimeDivider && (
        /* @@@ui-ruler 时间分隔 = Chip(小标签的唯一实现:18px 药丸、caption 字号、muted 底)。
           原来是这里自己拍的 10px 圆角 + 2/10 内距 + 裸 11px。 */
        <div style={{ textAlign: 'center', margin: 'var(--spacing-sm) 0 var(--spacing-xs)', userSelect: 'none' }}>
          <Chip>{formatCalendarDay(msg.created_at, { withTime: true })}</Chip>
        </div>
      )}
      {/* @@@multi-select (#988) — 多选态：行首勾选框 + 整行点击切换选中；内层气泡 pointer-events:none
          全面禁交互（连带隐藏悬浮操作条/菜单/长按）。
          @@@select-same-tree — 气泡在两种态下挂在同一棵外壳里，进出多选只改外壳的样式和勾选框;
          外壳要是只在多选态才包,每只可见气泡都会卸载重挂(正文 markdown 重解析),点「多选」整列卡一下。 */}
      {view.taskRecipient !== undefined ? <TaskExchangeBubble message={msg} recipientUserId={view.taskRecipient} mobile={shared.mobile} onOpenFile={handlers.onOpenFile} /> : !selectMode && view.agentFloodNotice ? (
        <AgentFloodSystemNotice messageId={msg.id} content={msg.content ?? ''} onUndone={handlers.onAgentFloodUndone} />
      ) : !selectMode && notice?.kind === 'member-joined' ? (
        <MemberJoinNotice userIds={notice.userIds} content={msg.content ?? ''} memberProfiles={bubbleMemberProfiles} onMention={handlers.onMentionMember} />
      ) : (
        <div
          data-message-select-row={selectMode ? msg.id : undefined}
          onClick={selectMode ? () => whole ? whole.toggle(isSelected) : handlers.onToggleSelect(msg.id) : undefined}
          style={selectMode ? { ...SELECT_ROW_STYLE, background: isSelected ? 'var(--accent-tint-row)' : undefined } : undefined}
        >
          {selectMode && <SelectionCheckbox checked={isSelected} />}
          <div style={selectMode ? SELECT_BUBBLE_STYLE : undefined}>{bubble}</div>
        </div>
      )}
      {/* @@@5856 锚点:这条消息长出来的话题挂在它底下(它是这条消息的附件,所以跟气泡同侧同缩进),
          双向连接的另一端是分栏标题块里那句「引自…」。正文要传进去:话题名默认就是从这条正文截的,
          没改过名时锚点不再把它念第二遍(owner:「你不感觉这个像是个文字重复吗」)。 */}
      {view.anchoredTopics && handlers.onOpenTopicAnchor && (
        <TopicAnchorCard topics={view.anchoredTopics} isMine={!!msg.is_mine} sourceContent={msg.content} onOpen={handlers.onOpenTopicAnchor} memberProfiles={bubbleMemberProfiles} />
      )}
    </div>
  )
})
/** The previous value while every field is the same reference. */
function useShallowShared<T>(next: T): T {
  const shared = useRef(next)
  if (!sameShallow(shared.current, next)) shared.current = next
  return shared.current
}
/** The row element and its place in the list (position, flash); only these primitives re-render it, not the list. */
const MessageListSlot = memo(function MessageListSlot({ id, index, count, flash, seenRows }: { id: string; index: number; count: number; flash: boolean; seenRows: SeenRows }) {
  return (
    <MessageRow index={index} count={count} messageId={id} className={flash ? 'msg-src-flash' : undefined} style={ROW_STYLE}>
      <MessageListRow id={id} seenRows={seenRows} />
    </MessageRow>
  )
})
const ROW_CONTENTS_STYLE: CSSProperties = { display: 'contents' }
const ROW_STYLE: CSSProperties = { paddingBottom: 'var(--spacing-xs)' }
// 分页的起点下标(prepend 时往下减);列表本身已按文档流排,这个数只剩窗口记账用。
export const VIRTUOSO_START_INDEX = 100000
// @@@5856 两份表面各报各的:未读定位(useUnreadLocatorNavigation)用 querySelector 取**文档序第一个**主表面,副栏另报 aside。
const SCROLLER_TEST_ID = { main: AUTOMATION_TEST_IDS.chatMessageList, aside: AUTOMATION_TEST_IDS.chatMessageListAside } as const
const LIST_FRAME_STYLE: CSSProperties = { position: 'relative', display: 'flex', flexDirection: 'column' }
// 原生滚动锚定(overflow-anchor 缺省 auto):视口上方的行变高时浏览器在同一次排版里改位置,见 lib/flowList.ts。
const LIST_SCROLLER_STYLE: CSSProperties = { flex: 1, minHeight: 0, position: 'relative', overflowX: 'hidden', overflowY: 'auto', outline: 'none' }
// 与底部「N 条新消息 ↓」同一身份(强调色药丸 + 浮层阴影),位置照微信放右上角。
const UNREAD_ABOVE_STYLE: CSSProperties = { position: 'absolute', top: 'var(--spacing-md)', right: 'var(--spacing-md)', zIndex: 'var(--z-float)', borderRadius: 'var(--radius-xl)', fontSize: 'var(--font-caption)', boxShadow: 'var(--shadow-lift)' }
/**
 * 列表本体:整个消息窗口按文档流排(store 已把窗口限在 MAX_WINDOW 行内),滚动机制在 lib/flowList.ts。
 * 分页 / 未读定位这些只有主线才有的东西从外面传。
 *
 * ⚠️ @@@5856 但「滚动」不在这一类里 —— 它是消息列表的**缺省义务**,不是主线的特权:
 * 不传落点 = 停在最新一条;在底部时内容一变就贴底(新消息、markdown 异步撑高)。分栏用的就是这份缺省。
 */
export function MessageList({
  rows: allRows,
  rowProps: allRowProps,
  resetKey,
  listRef,
  scrollerRef,
  initialTopMostItemIndex = OPEN_AT_LATEST,
  onAtBottomChange,
  followTail = true,
  onStartReached,
  style,
  surface = 'main',
  unreadAbove,
  footer,
}: {
  rows: ChatListRowItem[]
  rowProps: MessageListRowProps
  resetKey?: string | number
  listRef?: Ref<FlowListHandle>
  scrollerRef?: (element: HTMLElement | Window | null) => void
  initialTopMostItemIndex?: ListLanding | null // null = 落点还没定(恢复位置的锚点还在载入):先藏着,别露出最新处(#6595)
  onAtBottomChange?: (atBottom: boolean) => void
  followTail?: boolean
  onStartReached?: () => void
  style?: CSSProperties
  /** 这条消息流在哪一栏。只决定布局与自动化选择器;未读定位确认使用本视口 ref。 */
  surface?: 'main' | 'aside'
  /** @@@6530 这次打开时的第一条未读:在视口上方时右上角出「↑ N 条新消息」,点了跳过去。 */
  unreadAbove?: { messageId: string; messageSeq: number; label: string; onJump: () => void; onSeen?: () => void } | null
  /** 接在最后一条后面、随消息流一起滚的那一格(助理聊天里它在处理时的打字气泡);窗口没到最新处时不画。 */
  footer?: ReactNode
}): ReactNode {
  // #2581 Files sent at once are drawn as one message: the rows of a send collapse into its first.
  const { rows: drawnRows, albums: freshAlbums } = useMemo(() => collapseSendGroups(allRows), [allRows])
  const rows = drawnRows as ChatListRowItem[]
  // Every row reads the albums: unchanged sends keep the same value, so a message arriving elsewhere re-renders no album.
  const albumsRef = useRef(freshAlbums)
  if (!sameAlbums(albumsRef.current, freshAlbums)) albumsRef.current = freshAlbums
  const albums = albumsRef.current
  const rowProps = useMemo(() => albums.size ? { ...allRowProps, rows, messages: rows.map(row => row.message) } : allRowProps, [albums, allRowProps, rows])
  const ownScrollerRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const handleScrollerRef = useCallback((element: HTMLDivElement | null) => {
    ownScrollerRef.current = element
    scrollerRef?.(element)
  }, [scrollerRef])
  const rowIds = useMemo(() => rows.map((row) => row.message.id), [rows])
  // A list hidden while it waits for its landing is not on screen, though its rows still intersect the scroller.
  const landedRef = useRef(false)
  landedRef.current = initialTopMostItemIndex !== null
  // Rows call the latest handlers through these stable ones: a parent's fresh closure must not re-render every row.
  const latest = useRef(rowProps)
  latest.current = rowProps
  const [stableHandlers] = useState(() => {
    const call = <K extends keyof MessageListRowProps>(key: K) => (...args: unknown[]) => (latest.current[key] as ((...a: unknown[]) => unknown) | undefined)?.(...args)
    return {
      onReaction: call('onReaction'), onQuote: call('onQuote'), onForward: call('onForward'), onDelete: call('onDelete'), onToggleSelect: call('onToggleSelect'),
      onVisible: (message: MessageItem) => { if (landedRef.current) latest.current.onVisible(message) },
      isSelected: (messageId: string) => latest.current.selectedIds.has(messageId),
      ...Object.fromEntries(OPTIONAL_HANDLERS.map((key) => [key, call(key)])),
    } as Required<Handlers>
  })
  // An optional handler that is not given hides its menu item: only whether each is given is part of the rows' view.
  const given = OPTIONAL_HANDLERS.map((key) => (rowProps[key] ? '1' : '0')).join('')
  const handlers = useMemo<Handlers>(() => ({
    ...stableHandlers,
    ...Object.fromEntries(OPTIONAL_HANDLERS.map((key, i) => [key, given[i] === '1' ? stableHandlers[key] : undefined])),
  }), [given, stableHandlers])
  // 气泡里的名字(@、引用、任务卡)只认名字 / 头像 / 是否在群;agent 的运行态每翻一次,整张表就是新的,
  // 递下去会打穿每一只可见气泡的 memo(连同正文的 markdown 重新解析)。发送者自己的状态照旧走 memberProfile。
  const bubbleMemberProfiles = useStructurallyShared(useMemo(() => withoutLiveStatus(rowProps.memberProfiles), [rowProps.memberProfiles]))
  // A member's profile object stays the same while its fields do: a status flip re-renders that sender's rows only.
  const memberProfiles = useStructurallyShared(rowProps.memberProfiles)
  const quoteIds = useMemo(() => visibleReplyQuoteIds(rowProps.messages), [rowProps.messages])
  const [rowStore] = useState(() => createSelectStore<ListView>({ rows: new Map(), shared: null as unknown as ListShared }))
  const shared = useShallowShared<ListShared>({
    mobile: rowProps.mobile, isGroupChat: rowProps.isGroupChat, threeParty: rowProps.threeParty, selectMode: rowProps.selectMode,
    bubbleMemberProfiles, readReceiptHandle: rowProps.readReceiptHandle, memberProfileOpener: rowProps.memberProfileOpener, handlers,
  })
  const listView = useMemo<ListView>(() => ({
    rows: rowViewsOf(rows, { ...rowProps, memberProfiles }, albums, quoteIds, rowStore.get().rows),
    shared,
  }), [albums, memberProfiles, quoteIds, rowProps, rowStore, rows, shared])
  rowStore.publish(listView)
  useLayoutEffect(() => { rowStore.notify() }, [listView, rowStore])
  // The rows already seen are reported again when what decides whether a read counts changes: the window coming back to the
  // front (reads are only taken while the app is active) or a new `onVisible` from the caller (a split pane shown again).
  // Without re-rendering or re-observing any row.
  const [seenRows] = useState<SeenRows>(() => new Map())
  const appActive = useAppActive()
  useEffect(() => { if (appActive) for (const report of [...seenRows.values()]) report() }, [appActive, rowProps.onVisible, seenRows])
  const { start, end } = useFlowList({ scrollerRef: ownScrollerRef, contentRef, resetKey, rowIds, landing: initialTopMostItemIndex, followTail, atBottomThreshold: 80, onAtBottomChange, onStartReached, handleRef: listRef })
  // 未读行不在窗口里:比窗口最早一条还早 = 在上方(-1);否则是尾部对账还没回来,先不判(null)。
  const unreadIndex = unreadAbove ? rows.findIndex((row) => row.message.id === unreadAbove.messageId || !!albums.get(row.message.id)?.some(member => member.id === unreadAbove.messageId)) : -1
  const unreadAt = !unreadAbove ? null : unreadIndex >= 0 ? unreadIndex : rows.length > 0 && rows[0].message.seq > unreadAbove.messageSeq ? -1 : null
  const showUnreadAbove = useRowAboveViewport(ownScrollerRef, unreadIndex >= 0 ? rows[unreadIndex]!.message.id : unreadAbove?.messageId, unreadAt, initialTopMostItemIndex !== null, unreadAbove?.onSeen)
  const frameStyle = useMemo<CSSProperties>(() => ({ minHeight: 0, ...(style ?? { flex: 1 }), ...LIST_FRAME_STYLE, visibility: initialTopMostItemIndex === null ? 'hidden' : undefined }), [style, initialTopMostItemIndex])
  return (
    <RowStoreContext.Provider value={rowStore}>
    <MessageAlbumContext.Provider value={albums}>
    <div style={frameStyle}>
      {/* 每换一条线(resetKey)换一个滚动容器:落点、贴底电平、锚定都从这条线自己的第一帧开始。 */}
      <div key={resetKey} ref={handleScrollerRef} tabIndex={0} data-testid={SCROLLER_TEST_ID[surface]} data-unread-stream-surface={surface} data-chat-dock-reads="" data-message-avatars="true" data-image-gallery="" style={LIST_SCROLLER_STYLE}>
        <div ref={contentRef}>
          {rows.slice(start, end).map((row, i) => <MessageListSlot key={row.message.id} id={row.message.id} index={start + i} count={rows.length} flash={row.message.id === rowProps.flashMessageId} seenRows={seenRows} />)}
          {end >= rows.length ? footer : null}
          {/* 会话底部那一摞浮在消息流上(ChatBottomDock 写的 --chat-dock-h),滚到底的最后一条落在它上面;没有它就是 0。 */}
          <div aria-hidden data-chat-dock-reads="" className="h-[var(--chat-dock-h,0px)]" />
        </div>
      </div>
      {unreadAbove && showUnreadAbove && <Button variant="primary" size="sm" data-unread-above="" style={UNREAD_ABOVE_STYLE} onClick={unreadAbove.onJump}>{unreadAbove.label}</Button>}
    </div>
    </MessageAlbumContext.Provider>
    </RowStoreContext.Provider>
  )
}
