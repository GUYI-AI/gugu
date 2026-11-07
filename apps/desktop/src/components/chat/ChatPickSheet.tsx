import { Fragment, useRef, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { MessageSquare, X } from '@/lib/icons'
import { useMobileShell } from '../../hooks/useMobileShell'
import { Avatar, type AvatarProps } from '../Avatar'
import { SelectionCheckbox } from '../contacts/ContactSearch'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ListRow } from '../ui/ListRow'
import { SearchField } from '../ui/SearchField'
import { Sheet } from '../ui/Sheet'
import { SectionLabel } from '../ui/SectionLabel'

/** One chat to pick, drawn as the chat list draws it: `avatar` goes to `Avatar` as it is; a topic has none and draws the topic mark. */
export interface ChatPickRow {
  id: string
  name: ReactNode
  avatar?: AvatarProps
  /** After the name: a mark such as 「项目」. */
  badge?: ReactNode
  /** On the right: such as 「6 人」. */
  trailing?: ReactNode
  /** A second line under the name: why a search found it, or the group a lone topic belongs to. */
  hint?: ReactNode
  /** The topics grown out of this chat: drawn under it on the chat list's rail, picked as rows of their own. */
  topics?: readonly ChatPickRow[]
}

/** A run of rows under a heading (「我的任务」 below the chats): searched and picked as the rows above it are. */
export interface ChatPickSection {
  id: string
  title: ReactNode
  rows: readonly ChatPickRow[]
}

interface ChatPickSheetProps {
  title: string
  onClose: () => void
  testId: string
  rows: readonly ChatPickRow[]
  sections?: readonly ChatPickSection[]
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  query: string
  onQuery: (query: string) => void
  placeholder: string
  /** Said where no row is left. */
  empty: string
  /** Above the search field (forwarding: what is forwarded). */
  above?: ReactNode
  /** Above the rows while nothing is searched. */
  top?: ReactNode
  /** The foot: how many are picked (several at once; a one-row pick says nothing), and what the pick is for. */
  picked?: string
  actionLabel: string
  onAction: () => void
  actionDisabled?: boolean
  error?: string | null
}

// The topic sub-row of the chat list (TopicSubRow): indented onto the `.gg-topic-subrows` rail, the topic mark for an avatar.
const TOPIC_ROW_STYLE: CSSProperties = { paddingLeft: 40 }
const TOPIC_MARK = <MessageSquare size={13} className="shrink-0 self-center" style={{ color: 'var(--text-tertiary)' }} />

/**
 * Pick chats, several at once, in the invite picker's (MemberPicker) clothes: a title, a search field, the picked as chips,
 * each chat with a round tick and its topics under it. The forward sheet (ForwardMessageDialog), 「添加群或项目」 (AppPlaces)
 * and an App's dispatch (DispatchSheet) are this one sheet; which rows a search leaves, what a row says and what the pick is
 * for are the caller's. Each row carries its chat id in `data-pick-row`.
 */
export function ChatPickSheet(props: ChatPickSheetProps) {
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  const { rows, sections = [], selected, query, actionDisabled = false } = props
  // A chip outlives the search that hid its row: every row seen is kept by id.
  const seen = useRef(new Map<string, ChatPickRow>()).current
  const renderRow = (row: ChatPickRow, topic = false): ReactNode => {
    seen.set(row.id, row)
    return (
      <Fragment key={row.id}>
        <ListRow
          data-pick-row={row.id}
          role="option"
          aria-selected={selected.has(row.id)}
          mobile={mobile}
          style={topic ? TOPIC_ROW_STYLE : undefined}
          onClick={() => props.onToggle(row.id)}
          leading={<><SelectionCheckbox checked={selected.has(row.id)} />{row.avatar ? <Avatar size={mobile ? 'md' : 'sm'} {...row.avatar} /> : TOPIC_MARK}</>}
          title={row.name}
          accessory={row.badge}
          meta={row.trailing}
          subtitle={row.hint}
        />
        {row.topics?.length ? <div className="gg-topic-subrows">{row.topics.map((one) => renderRow(one, true))}</div> : null}
      </Fragment>
    )
  }
  const list = [...rows.map((row) => renderRow(row)), ...sections.map((section) => section.rows.length > 0 && (
    <div key={section.id} data-pick-section={section.id}>
      <SectionLabel>{section.title}</SectionLabel>
      {section.rows.map((row) => renderRow(row))}
    </div>
  ))]
  const chips = [...selected].flatMap((id) => seen.get(id) ?? [])
  const action = (
    <Button variant="primary" size={mobile ? 'sm' : 'md'} onClick={props.onAction} disabled={actionDisabled} data-testid={`${props.testId}-action`}>
      {props.actionLabel}
    </Button>
  )
  const close = <IconButton aria-label={t('common.close')} onClick={props.onClose}><X size={18} /></IconButton>
  return (
    <Sheet
      onClose={props.onClose}
      desktopWidth="min(480px, 100%)"
      desktopHeight="min(640px, calc(100dvh - 32px))"
      fullScreenMobile
      testId={props.testId}
      ariaLabel={props.title}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className={cn('flex items-center gap-2', mobile ? '!px-3 !pt-3 !pb-2' : '!px-5 !pt-4 !pb-3')}>
          {mobile ? close : null}
          <h3 className={cn('m-0 min-w-0 flex-1 truncate text-[length:var(--font-heading)] font-semibold text-[var(--text-primary)]', mobile && 'text-center')}>{props.title}</h3>
          {mobile ? action : close}
        </div>
        <div className={cn('flex flex-col gap-2 !pb-2', mobile ? '!px-3' : '!px-5')}>
          {props.above}
          <SearchField value={query} onChange={(event) => props.onQuery(event.target.value)} placeholder={props.placeholder} autoFocus={!mobile}
            clearLabel={t('chatList.clearSearch')} onClear={() => props.onQuery('')} />
        </div>
        {chips.length > 0 ? (
          <div className={cn('flex shrink-0 gap-2 overflow-x-auto !pb-2', mobile ? '!px-3' : '!px-5')}>
            {chips.map((row) => (
              <Button key={row.id} variant="secondary" size="sm" onClick={() => props.onToggle(row.id)} className="shrink-0 gap-2 !rounded-[var(--radius-capsule)] !pl-1">
                {row.avatar ? <Avatar {...row.avatar} size="xs" /> : TOPIC_MARK}
                <span className="max-w-[160px] truncate">{row.name}</span><X size={12} />
              </Button>
            ))}
          </div>
        ) : null}
        <div role="listbox" aria-multiselectable="true" className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--border-subtle)] !px-2 !pb-3">
          {!query.trim() && props.top}
          {rows.length === 0 && sections.every((section) => section.rows.length === 0)
            ? <p className="!m-0 !p-8 text-center text-[length:var(--font-body)] text-[var(--muted-fg)]">{props.empty}</p>
            : list}
        </div>
        {props.error ? <p role="alert" className="!m-0 !px-5 !py-2 text-[length:var(--font-caption)] text-[var(--danger-fg)]">{props.error}</p> : null}
        {!mobile ? (
          <div className="flex shrink-0 items-center justify-end gap-3 border-t border-[var(--border-subtle)] !px-5 !py-3">
            <span className="min-w-0 flex-1 truncate text-[length:var(--font-caption)] text-[var(--muted-fg)]">{props.picked}</span>
            {action}
          </div>
        ) : null}
      </div>
    </Sheet>
  )
}
