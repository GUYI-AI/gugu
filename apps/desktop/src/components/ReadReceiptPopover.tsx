import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { Avatar } from './Avatar'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { groupAgentStatusRank } from '@/lib/groupAgentStatus'
import { Check } from '@/lib/icons'
import { Popover } from './ui/Popover'
import { Button } from './ui/Button'
import { GrowingList } from '@gugu/session-ui/react/growing-list'
import { ListRowContent } from './ui/ListRow'
import { SectionLabel } from './ui/SectionLabel'
import type { ReadReceiptHandle } from '@/hooks/useReadReceiptPanel'
import { useTranslation } from 'react-i18next'

// @@@1345 已读回执弹层：点击消息气泡的已读圆环 → 一列名单，「已读 N」在上、「未读 N」在下（与群成员列表同一种分区）。
// 全员已读时只有一个「全部已读」分区，不出空的那一栏。名册由 ChatAreaPanel / TopicSplitPane 映射传入。
export interface ReadReceiptMember {
  id: string
  displayName: string
  avatar: string | null
  isAgent: boolean
  agentStatus?: AgentDisplayStatus
  /** 没有运行中的实例持有它:这条消息到不了它,只它一个,与气泡旁那行同一句话。 */
  undelivered?: boolean
}

/** 每组先给这么多人，其余收进「还有 N 位」：打开时两组的开头都在眼前，不被一组刷满。 */
const GROUP_PREVIEW = 20
const MAX_HEIGHT = 288

type Line =
  | { kind: 'head'; group: 'read' | 'unread' | 'all'; count: number }
  | { kind: 'member'; member: ReadReceiptMember }
  | { kind: 'more'; group: 'read' | 'unread'; count: number }

function MemberRow({ member }: { member: ReadReceiptMember }) {
  const identity = useAvatarIdentity(member.isAgent ? member.id : '')
  const name = useShownAgentName({ name: member.displayName, createdAt: member.isAgent ? identity?.created_at ?? undefined : undefined })
  const { t } = useTranslation('messaging')
  return (
    // 名字放不下时才截断；悬停给全名。
    <div className="gg-list-row" title={name}>
      <ListRowContent leading={<Avatar name={name} avatarUrl={member.avatar} seed={member.id} isAgent={member.isAgent} agentStatus={member.agentStatus} size="sm" />} title={name}
        subtitle={member.undelivered ? <span title={t('agent.turnFailure.undelivered')}>{t('message.sendStatus.undelivered')}</span> : undefined} />
    </div>
  )
}

export function ReadReceiptPopover({
  handle,
  receiptOf,
  testId,
}: {
  /** 已读圆环们(`Popover.Trigger handle payload=消息 id`)共用的浮层;Base UI 随列表滚动重量那颗环。 */
  handle: ReadReceiptHandle
  receiptOf: (messageId: string) => { readers: ReadReceiptMember[]; unreaders: ReadReceiptMember[] } | null
  testId?: string
}) {
  return (
    <Popover.Root handle={handle} modal={false}>
      {({ payload }) => {
        const receipt = payload ? receiptOf(payload) : null
        // key = 消息:换一条消息,展开状态和滚动位置都从头来。
        return receipt ? <ReadReceiptList key={payload} readers={receipt.readers} unreaders={receipt.unreaders} testId={testId} /> : null
      }}
    </Popover.Root>
  )
}

function linesOf(readers: ReadReceiptMember[], unreaders: ReadReceiptMember[], expanded: ReadonlySet<'read' | 'unread'>): Line[] {
  const lines: Line[] = []
  const group = (key: 'read' | 'unread', members: ReadReceiptMember[]) => {
    const shown = expanded.has(key) ? members : members.slice(0, GROUP_PREVIEW)
    for (const member of shown) lines.push({ kind: 'member', member })
    if (shown.length < members.length) lines.push({ kind: 'more', group: key, count: members.length - shown.length })
  }
  if (readers.length > 0) {
    lines.push({ kind: 'head', group: unreaders.length === 0 ? 'all' : 'read', count: readers.length })
    group('read', readers)
  }
  if (unreaders.length > 0) {
    lines.push({ kind: 'head', group: 'unread', count: unreaders.length })
    // 未读的人里,在线的 agent 排前面(名册里现成的 agent 状态,与群成员列表同一个次序);人没有在线读数,算「确认中」那一档,保持原序。
    group('unread', [...unreaders].sort((a, b) => groupAgentStatusRank(b.agentStatus ?? 'pending') - groupAgentStatusRank(a.agentStatus ?? 'pending')))
  }
  return lines
}

function ReadReceiptList({ readers, unreaders, testId }: {
  readers: ReadReceiptMember[]
  unreaders: ReadReceiptMember[]
  testId?: string
}) {
  const { t } = useTranslation('messaging')
  const { t: ct } = useTranslation('contacts')
  const [expanded, setExpanded] = useState<ReadonlySet<'read' | 'unread'>>(() => new Set())
  const popupRef = useRef<HTMLDivElement>(null)
  // 滚动每一帧都重画这一窗;名单只在换消息、展开时重排。
  const lines = useMemo(() => linesOf(readers, unreaders, expanded), [readers, unreaders, expanded])
  // @@@receipt-window - 只挂可见那一窗的行(@@@growing-list):打开 2000 人群的回执和打开 5 人群一样多的节点(owner 的 O(1) 标准)。
  // 当前分区的标题吸顶。
  // 宽度跟着挂上的名字走(200–320),但滚动时只长不缩:换一窗名字时卡片不来回跳。
  useLayoutEffect(() => {
    const popup = popupRef.current
    if (popup) popup.style.minWidth = `${Math.max(parseFloat(popup.style.minWidth) || 0, popup.offsetWidth)}px`
  })

  const lineNode = (line: Line) => {
    if (line.kind === 'member') return <MemberRow member={line.member} />
    if (line.kind === 'more') {
      return (
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setExpanded((previous) => new Set(previous).add(line.group))}>
          {ct('groupDetail.remainingMembers', { count: line.count })}
        </Button>
      )
    }
    const all = line.group === 'all'
    return (
      <SectionLabel style={{ background: 'var(--bg-elevated)' }} trailing={all ? <Check size={14} aria-hidden /> : <span className="tabular-nums">{line.count}</span>}>
        {all ? t('message.receipt.allRead') : t(line.group === 'read' ? 'message.read' : 'message.unread')}
      </SectionLabel>
    )
  }

  // 锚在已读圆环按钮上（本人气泡下沿）→ Base UI 负责视口碰撞与 Escape/outside press。
  return (
    <Popover.Portal>
      <Popover.Positioner
        positionMethod="fixed"
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        // 放不下就翻到环的另一侧(同 ui/Menu),❌ 平移着盖住环:盖住了,再点一次环就点在名单上,关不掉(手机,11-09)。
        collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
      >
        <Popover.Popup
          ref={popupRef}
          role="dialog"
          aria-label={t('message.receipt.title')}
          data-testid={testId}
          style={{
            // 与 AgentSharePopover / ui/Menu 同一种浮层皮:--bg-elevated 底 + --shadow-popover(hairline 在投影里),❌ 再叠一圈边框。
            width: 'max-content',
            minWidth: 200,
            maxWidth: 'min(320px, calc(100vw - 16px))',
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-xl)',
            boxShadow: 'var(--shadow-popover)',
            color: 'var(--text-primary)',
            padding: 4,
          }}
        >
          <GrowingList
            count={lines.length}
            getKey={(index) => index}
            estimateSize={(index) => (lines[index]!.kind === 'member' ? 48 : 28)}
            isSticky={(index) => lines[index]!.kind === 'head'}
            overscan={6}
            scrollerStyle={{ maxHeight: MAX_HEIGHT, overscrollBehavior: 'contain' }}
            renderLine={(index) => lineNode(lines[index]!)}
          />
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  )
}
