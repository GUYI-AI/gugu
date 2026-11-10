import { Avatar } from './Avatar'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { Popover } from './ui/Popover'
import type { ReadReceiptHandle } from '@/hooks/useReadReceiptPanel'
import { useTranslation } from 'react-i18next'

// @@@1345 已读回执弹层：点击消息气泡的进度圆环 → 弹「X 已读 | Y 未读」+ 左右两列头像名单。
// 名册由 ChatAreaPanel 映射传入；显示名沿用已有身份桥的创建时间。
export interface ReadReceiptMember {
  id: string
  displayName: string
  avatar: string | null
  isAgent: boolean
}

function MemberRow({ member }: { member: ReadReceiptMember }) {
  const identity = useAvatarIdentity(member.isAgent ? member.id : '')
  const name = useShownAgentName({ name: member.displayName, createdAt: member.isAgent ? identity?.created_at ?? undefined : undefined })
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', minWidth: 0 }}>
      <Avatar name={name} avatarUrl={member.avatar} seed={member.id} isAgent={member.isAgent} size="sm" />
      <span
        style={{
          fontSize: 'var(--font-body)',
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {name}
      </span>
    </div>
  )
}

function MemberColumn({ title, count, members, emptyText }: {
  title: string
  count: number
  members: ReadReceiptMember[]
  emptyText: string
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 'var(--font-caption)', fontWeight: 600, color: 'var(--text-secondary)', padding: '0 4px 6px' }}>
        {title} {count}
      </div>
      {members.length === 0 ? (
        <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', padding: '5px 4px' }}>{emptyText}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 240, overflowY: 'auto' }}>
          {members.map((m) => (
            <MemberRow key={m.id} member={m} />
          ))}
        </div>
      )}
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
        return receipt ? <ReadReceiptLists readers={receipt.readers} unreaders={receipt.unreaders} testId={testId} /> : null
      }}
    </Popover.Root>
  )
}

function ReadReceiptLists({ readers, unreaders, testId }: {
  readers: ReadReceiptMember[]
  unreaders: ReadReceiptMember[]
  testId?: string
}) {
  const { t } = useTranslation('messaging')
  const width = 280
  const gap = 8
  // 锚在已读圆环按钮上（本人气泡下沿）→ Base UI 负责视口碰撞与 Escape/outside press。
  return (
      <Popover.Portal>
        <Popover.Positioner
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={gap}
          collisionPadding={8}
          // 放不下就翻到环的另一侧(同 ui/Menu),❌ 平移着盖住环:盖住了,再点一次环就点在名单上,关不掉(手机,11-09)。
          collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
        >
          <Popover.Popup
            role="dialog"
            aria-label={t('message.receipt.title')}
            data-testid={testId}
            style={{
              width,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              boxShadow: 'var(--shadow-popover-strong)',
              color: 'var(--text-primary)',
              padding: 12,
            }}
          >
            <div style={{ display: 'flex', gap: 12 }}>
              <MemberColumn title={t('message.read')} count={readers.length} members={readers} emptyText={t('message.receipt.noneRead')} />
              <div style={{ width: 1, background: 'var(--border-subtle)', alignSelf: 'stretch' }} />
              <MemberColumn title={t('message.unread')} count={unreaders.length} members={unreaders} emptyText={t('message.receipt.allRead')} />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
  )
}
