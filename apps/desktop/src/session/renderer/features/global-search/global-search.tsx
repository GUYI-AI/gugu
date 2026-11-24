import { IdentityPlaceholder } from '@/components/IdentityPlaceholder'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { GrowingList, type GrowingListWindow } from '@gugu/session-ui/react/growing-list'
import { observer } from 'mobx-react-lite'
import { Avatar } from '@/components/Avatar'
import { ListRowContent } from '@/components/ui/ListRow'
import { SectionLabel } from '@/components/ui/SectionLabel'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { AtSign, Clock, FileText, FolderOpen, History, Image, Link, MessageSquare, Users, X } from '@/lib/icons'
import { FileMark } from '@gugu/session-ui/file-mark'
import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { openMessageSender } from '@/lib/openMessageSender'
import { followLink } from '@/lib/guguLinks'
import { UI_EVENTS } from '@/lib/uiEvents'
import { messageForUser } from '@/lib/userFacingError'
import { askTaskReveal } from '@/hooks/useSourceMessageReveal'
import { askFlashWords } from '@/lib/sourceMessageReveal'
import { conversationLink } from '@gugu/core/shared/ui/guguLink'
import { messageQuoteLink } from '@gugu/core/shared/ui/messageQuote'
import { refreshFailure, retryOf, useReplica, valueOf } from '@/lib/replica'
import { ReadFailedLine } from '@renderer/lib/ui/read-failed-line'
import { matchRanges } from '@shared/core/search'
import { Shortcut } from '@renderer/lib/ui/shortcut'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { cn } from '@renderer/utils/utils'
import { Unknown } from '@/components/ui/Unknown'
import { EVERYWHERE, forgetSearches, recentSearches, rememberSearch, updateSearchSession, useSearchSession, type SearchChip, type SearchFacet, type SearchKind } from './search-session'
import { SearchIcon } from './search-icon'
import { firstMessageOn, instant, SEARCH_LIMIT, useGlobalSearch, type SearchHit } from './use-global-search'
import { sessionAgentBindings } from '../sessions/stores/session-agent-bindings'
import { commandPaletteSearch, usePaletteTasks } from '../command-palette/palette-search-data'
import { rankPaletteMatches } from '../command-palette/palette-rank'
import { openGroup, openPerson, useNameMatches } from '../command-palette/palette-chats'

const ResultAvatar = observer(function ResultAvatar({ hit, name }: { hit: SearchHit; name: string }) {
  const system = hit.kind === 'message' && hit.sender === null
  const file = hit.kind === 'message' && hit.file
  const senderId = hit.kind === 'message' ? (system || file ? '' : hit.senderId ?? '')
    : hit.role === 'assistant' ? sessionAgentBindings.bindingFor(hit.taskId)?.agentUserId ?? '' : ''
  const identity = useAvatarIdentity(senderId)
  return system ? <IdentityPlaceholder className="mt-1" /> : (
    <span className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground/[0.07] text-[length:var(--font-caption)] font-medium text-foreground/55">
      {file ? <FileMark name={hit.kind === 'message' ? hit.fileName ?? '' : ''} size={12} /> : senderId
        ? <Avatar name={identity?.display_name ?? name} avatarUrl={identity?.avatar} seed={senderId} size={20} isAgent={identity?.type === 'agent'} still />
        : Array.from(name)[0]}
    </span>
  )
})

type NameMatch = {
  id: string
  name: string
  leading: ReactNode
  subtitle?: string
  open: () => void
}

const PersonAvatar = observer(function PersonAvatar({ userId, name }: { userId: string; name: string }) {
  const identity = useAvatarIdentity(userId)
  return <Avatar name={identity?.display_name ?? name} avatarUrl={identity?.avatar} seed={userId} size={20} isAgent={identity?.type === 'agent'} still />
})

// @@@search-line-height - where the lines not mounted yet go (every mounted line is measured). A scope line is 34 px; a hit is
// 58 px with one line of text and 78 px with two (line-clamp-2). Whether the text wraps is guessed from its width at 14 px
// (a wide CJK character ≈ 14 px, any other ≈ 7) against the text column: the list minus its padding and the row's (2 × 8 each),
// the avatar (20) and the gap (10).
const SCOPE_LINE_HEIGHT = 34
function hitHeight(text: string, list: HTMLElement | null): number {
  let width = 0
  for (const char of text) width += char.codePointAt(0)! >= 0x2e80 ? 14 : 7
  return list && width > list.clientWidth - 62 ? 78 : 58
}

function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  const parts: ReactNode[] = []
  let at = 0
  for (const { start, end } of matchRanges(text, query)) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={start} className="rounded-[2px] bg-[var(--accent-tint-row)] px-px text-inherit">{text.slice(start, end)}</mark>)
    at = end
  }
  parts.push(text.slice(at))
  return parts
}

const NAMED_LIMIT = 5

function formatWhen(iso: string): string {
  const date = new Date(instant(iso))
  const now = new Date()
  return new Intl.DateTimeFormat(undefined, date.toDateString() === now.toDateString() ? { hour: '2-digit', minute: '2-digit' }
    : date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
}

/** Go to where a hit was said: a chat message through its conversation link, a task turn through the task's reveal. */
export function openHit(hit: SearchHit, words = ''): void {
  if (hit.kind === 'message') { askFlashWords(hit.messageId, words); followLink(conversationLink(hit.chatId, hit.messageId)); return }
  askTaskReveal(hit.taskId, messageQuoteLink({ kind: 'session', sessionId: hit.taskId, itemId: hit.itemId }))
  followLink({ kind: 'session', sessionId: hit.taskId, projectId: hit.projectId })
  window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked))
}

/** Desktop searches names and content together. Mobile keeps its existing chat search and named contacts. */
export function GlobalSearch({ tasks, names = false, desktop = false, currentGroupId, onClose, onOpen }: {
  tasks: boolean
  names?: boolean
  desktop?: boolean
  currentGroupId?: string
  onClose: () => void
  onOpen: () => void
}) {
  const { translate } = useSessionMessages()
  const { text, chips, facet, selectedId } = useSearchSession()
  const summaries = useChatSummaries()
  const view = useGlobalSearch(text, chips, facet, tasks)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [composition, setComposition] = useState<string | null>(null)
  const [list, setList] = useState<HTMLDivElement | null>(null)
  const lineWindowRef = useRef<GrowingListWindow | null>(null)
  const facets: readonly SearchFacet[] = tasks ? ['all', 'message', 'task', 'file'] : ['all', 'message', 'file']

  const chatName = (chatId: string) => summaries.get(chatId)?.alias || summaries.get(chatId)?.name || translate('globalSearch.unknownChat')
  const chipLabel = (chip: SearchChip) => chip.kind === 'in' ? chatName(chip.chatId) : chip.kind === 'in-task' ? chip.title : chip.kind === 'type' ? translate(`globalSearch.kind.${chip.type}`) : chip.name
  const groups: { key: string; label: string; task: boolean; scope: SearchChip; hits: SearchHit[] }[] = []
  if (view.hits) for (const hit of view.hits) {
    let group = groups.find((existing) => existing.key === hit.group)
    if (!group) {
      group = hit.kind === 'task'
        ? { key: hit.group, label: hit.title, task: true, scope: { kind: 'in-task', taskId: hit.taskId, title: hit.title }, hits: [] }
        : { key: hit.group, label: chatName(hit.chatId), task: false, scope: { kind: 'in', chatId: hit.chatId }, hits: [] }
      groups.push(group)
    }
    group.hits.push(hit)
  }
  const ordered = groups.flatMap((group) => group.hits)
  const scoped = view.scopes.some((chip) => chip.kind === 'in' || chip.kind === 'in-task')
  // @@@growing-list: the results mount around the visible part of the panel; a group's scope line heads its hits.
  const lines = groups.flatMap((group) => [...(scoped ? [] : [{ kind: 'scope' as const, group }]), ...group.hits.map((hit) => ({ kind: 'hit' as const, hit }))])
  const showNames = (desktop || names) && !!view.query && !view.unresolved && facet === 'all' && view.scopes.length === 0
  const named = useNameMatches(view.query, desktop ? 20 : NAMED_LIMIT, showNames)
  // The shared search query is already debounced. Send title and content reads in parallel.
  const titleQuery = view.query
  const readingTitles = desktop && showNames
  const titles = useReplica(commandPaletteSearch, readingTitles ? [titleQuery] : null)
  const titleResults = readingTitles ? valueOf(titles) ?? null : null
  const titleError = readingTitles ? refreshFailure(titles) : null
  const titlePending = desktop && showNames && !titleError && titleResults === null
  const taskMatches = usePaletteTasks(titleResults, titleQuery)
  const projectMatches = rankPaletteMatches(titleResults?.filter((item) => item.kind === 'project') ?? [], titleQuery, (item) => [item.title], { recallOnly: true })
  const nameRows: NameMatch[] = [
    ...named.groups.map(([id, chat]) => ({ id: `chat:${id}`, name: chat.alias || chat.name || '',
      leading: <Avatar name={chat.alias || chat.name || ''} avatarUrl={chat.avatar} seed={id} size={20} variant="group" />,
      open: () => openGroup(id) })),
    ...named.people.map((person) => ({ id: `person:${person.id}`, name: person.name,
      leading: <PersonAvatar userId={person.id} name={person.name} />,
      open: () => {
        if (desktop && !person.chatId) openMessageSender({ kind: 'sender', userId: person.id })
        else openPerson(person.id, person.chatId)
      } })),
    ...projectMatches.map((item) => ({ id: `project:${item.id}`, name: item.title,
      leading: <FolderOpen size={16} />, subtitle: translate('palette.projects'),
      open: () => followLink({ kind: 'project', projectId: item.id }) })),
    ...(taskMatches ?? []).flatMap((item) => {
      const { id, projectId, deviceId } = item
      if (!projectId) return []
      return [{ id: `task:${id}`, name: item.title, leading: <MessageSquare size={16} />,
        subtitle: item.deviceLabel || translate('palette.tasks'),
        open: () => followLink({ kind: 'session', sessionId: id, projectId, deviceId }) }]
    }),
  ]
  const resultIds = [...(desktop ? nameRows.map((row) => row.id) : []), ...ordered.map((hit) => hit.id)]
  const selection = selectedId && resultIds.includes(selectedId) ? selectedId : resultIds[0]
  const selected = ordered.find((hit) => hit.id === selection)
  const selectedName = nameRows.find((row) => row.id === selection)
  // Words, a sender or a kind of message: any of them is a search; with none the panel shows the quick filters.
  const hasQuery = !!text.trim() || chips.some((chip) => chip.kind === 'from' || chip.kind === 'type')
  const inChat = chips.find((chip) => chip.kind === 'in')?.chatId ?? null
  const canScopeToGroup = !!currentGroupId && !view.scopes.some((chip) => chip.kind === 'in' || chip.kind === 'in-task')
  const inputRef = useRef<HTMLInputElement>(null)
  const [dateNote, setDateNote] = useState<string | null>(null)

  const selectedNameRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { selectedNameRef.current?.scrollIntoView({ block: 'nearest' }) }, [selectedName?.id])
  const selectedLine = lines.findIndex((line) => line.kind === 'hit' && line.hit.id === selected?.id)
  useEffect(() => { if (selectedLine >= 0) lineWindowRef.current?.scrollToIndex(selectedLine, { align: 'auto' }) }, [selectedLine])

  const open = (hit: SearchHit) => {
    if (hit.kind === 'message') updateSearchSession({ selectedId: hit.id })
    if (view.query) rememberSearch(recentScope, view.query)
    onOpen(); openHit(hit, view.query)
  }
  const addKind = (type: SearchKind) => { if (!chips.some((chip) => chip.kind === 'type' && chip.type === type)) setChips([...chips, { kind: 'type', type }]) }
  // 「日期」 alone goes straight to that day's first message in this conversation.
  const jumpToDay = async (day: string) => {
    if (!inChat || !day) return
    const messageId = await firstMessageOn(inChat, day)
    if (!messageId) { setDateNote(translate('globalSearch.noMessageFrom', { date: day })); return }
    onOpen(); followLink(conversationLink(inChat, messageId))
  }
  const quick: { key: string; icon: ReactNode; label: string; run: (target: HTMLElement) => void; scoped?: boolean }[] = [
    { key: 'member', icon: <Users size={16} />, label: translate('globalSearch.quick.member'), scoped: true,
      run: () => { updateSearchSession({ text: 'from:', selectedId: null }); inputRef.current?.focus() } },
    { key: 'date', icon: <Clock size={16} />, label: translate('globalSearch.quick.date'), scoped: true,
      run: (target) => target.parentElement?.querySelector<HTMLInputElement>('input[type=date]')?.showPicker() },
    { key: 'media', icon: <Image size={16} />, label: translate('globalSearch.kind.media'), run: () => addKind('media') },
    { key: 'file', icon: <FileText size={16} />, label: translate('globalSearch.kind.file'), run: () => addKind('file') },
    { key: 'link', icon: <Link size={16} />, label: translate('globalSearch.kind.link'), run: () => addKind('link') },
    { key: 'mention', icon: <AtSign size={16} />, label: translate('globalSearch.kind.mention'), run: () => addKind('mention') },
  ]
  const recentScope = inChat ?? EVERYWHERE
  const [, setForgotten] = useState(0)
  const recent = recentSearches(recentScope)
  const openName = (row: NameMatch) => {
    rememberSearch(recentScope, view.query)
    onOpen()
    row.open()
  }
  const move = (direction: 1 | -1) => {
    if (!resultIds.length) return
    const at = selection ? resultIds.indexOf(selection) : -1
    updateSearchSession({ selectedId: resultIds[Math.min(resultIds.length - 1, Math.max(0, at + direction))]! })
  }
  const setChips = (next: SearchChip[]) => updateSearchSession({ chips: next, selectedId: null })
  const cycleFacet = (direction: 1 | -1) =>
    updateSearchSession({ facet: facets[(facets.indexOf(facet) + direction + facets.length) % facets.length]!, selectedId: null })
  const countLabel = (count: number) => (view.capped && count >= SEARCH_LIMIT ? `${SEARCH_LIMIT}+` : String(count))

  return (
    <div className={cn('relative flex flex-col overflow-hidden', desktop ? 'min-h-0 flex-1' : 'max-h-[min(600px,80vh)] max-sm:h-full max-sm:max-h-none')} data-testid="global-search">
      {desktop && <div data-modal-drag="" data-testid="global-search-drag" aria-hidden="true" className="window-no-drag-region h-3 shrink-0 cursor-grab touch-none active:cursor-grabbing" />}
      {/* The phone page: the field is a filled capsule, roomier than the desktop modal's bare row. */}
      <div className={cn('flex h-12 shrink-0 items-center gap-2 max-sm:h-16 max-sm:gap-3',
        desktop ? 'mx-2 rounded-lg border border-border px-2' : 'px-4')} data-testid="global-search-bar">
        <div className="flex h-full min-w-0 flex-1 items-center gap-2 max-sm:h-11 max-sm:rounded-full max-sm:bg-foreground/[0.06] max-sm:px-4">
        <SearchIcon className="size-4 shrink-0 text-foreground/40 max-sm:size-5" />
        {chips.map((chip, index) => (
          <span key={`${chip.kind}:${index}`} className="flex h-6 min-w-0 max-w-40 items-center gap-1 rounded-md bg-foreground/[0.06] pl-2 pr-1 text-xs text-foreground/75">
            <span className="truncate">{chipLabel(chip)}</span>
            <button type="button" aria-label={translate('globalSearch.removeChip')} onClick={() => setChips(chips.filter((_, at) => at !== index))}
              className="grid h-5 w-5 place-items-center rounded text-foreground/40 hover:bg-foreground/10 hover:text-foreground"><X className="h-3 w-3" /></button>
          </span>
        ))}
        <input ref={inputRef} autoFocus enterKeyHint="search" value={composition ?? text} data-testid="global-search-input" aria-label={translate(names || desktop ? 'globalSearch.placeholderNames' : 'globalSearch.placeholder')}
          placeholder={translate(chips.length ? 'globalSearch.placeholderScoped' : names || desktop ? 'globalSearch.placeholderNames' : 'globalSearch.placeholder')}
          className="h-full min-w-24 flex-1 bg-transparent text-[length:var(--font-title)] outline-none placeholder:text-foreground/35"
          onCompositionStart={(event) => setComposition(event.currentTarget.value)}
          onCompositionEnd={(event) => { setComposition(null); updateSearchSession({ text: event.currentTarget.value, selectedId: null }) }}
          onChange={(event) => { if (composition === null) updateSearchSession({ text: event.target.value, selectedId: null }); else setComposition(event.target.value) }}
          onKeyDown={(event) => {
            if (composition !== null || event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1) }
            else if (event.key === 'Enter') { event.preventDefault(); if (selectedName) openName(selectedName); else if (selected) open(selected) }
            else if (event.key === 'Tab' && (hasQuery || names)) { event.preventDefault(); cycleFacet(event.shiftKey ? -1 : 1) }
            else if (event.key === 'Backspace' && !event.currentTarget.value && chips.length) { event.preventDefault(); setChips(chips.slice(0, -1)) }
          }} />
        </div>
        {canScopeToGroup && (
          <button type="button" data-testid="global-search-current-group"
            className="h-8 shrink-0 rounded-md px-2 text-sm text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground"
            onClick={() => { setChips([...chips, { kind: 'in', chatId: currentGroupId }]); inputRef.current?.focus() }}>
            {translate('globalSearch.currentGroup')}
          </button>
        )}
        {!names && !hasQuery && (
          <button type="button" aria-expanded={filtersOpen} data-testid="global-search-filter-toggle"
            className="h-8 shrink-0 rounded-md px-2 text-sm text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground aria-expanded:bg-foreground/[0.06] aria-expanded:text-foreground"
            onClick={() => setFiltersOpen(!filtersOpen)}>
            {translate('globalSearch.filters')}
          </button>
        )}
        <button type="button" onClick={onClose} className="-mr-2 min-h-11 shrink-0 px-2 text-[length:var(--font-title)] text-foreground sm:hidden">{translate('globalSearch.cancel')}</button>
      </div>

      {hasQuery && (
        <div className="relative flex h-9 shrink-0 items-end gap-5 overflow-x-auto border-b border-foreground/[0.08] px-4 [scrollbar-width:none]" role="tablist">
          {facets.map((value) => {
            const on = facet === value
            const count = view.counts ? view.counts[value] : null
            return (
              <button type="button" role="tab" aria-selected={on} key={value} tabIndex={-1}
                onClick={() => updateSearchSession({ facet: value, selectedId: null })}
                className={cn('relative flex h-full shrink-0 items-center gap-2 text-[length:var(--font-body)] transition-colors',
                  on ? 'text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:rounded-full after:bg-foreground' : 'text-foreground/50 hover:text-foreground/80')}>
                {translate(`globalSearch.facet.${value}`)}
                {/* The largest count is 100+: unknown, zero and digits occupy the same slot. Zero stays blank (❌ "0": a source
                    that failed answers no rows, and that is not "none found"; the failure is said below). */}
                <span className="inline-block w-[4ch] shrink-0 tabular-nums text-foreground/35">
                  {count === null ? <Unknown className="w-full" /> : count ? countLabel(count) : null}
                </span>
              </button>
            )
          })}
          {view.loading && <span aria-hidden className="absolute inset-x-0 -bottom-px h-px overflow-hidden"><span className="block h-full w-1/3 animate-[gs-scan_1s_ease-in-out_infinite] bg-[var(--accent)]" /></span>}
        </div>
      )}

      {/* The previous words' results while these words' are on their way: kept in place and dimmed after 150 ms (.gg-stale, the unknown slot's rule), ❌ emptied per keystroke. */}
      <div ref={setList} data-growing-list="" data-stale={view.stale || undefined} aria-busy={view.stale || undefined}
        className={cn('flex-1 overflow-y-auto px-2', desktop ? 'min-h-0' : hasQuery && 'min-h-48', hasQuery && 'pb-2', view.stale && 'gg-stale')} role="listbox" aria-label={translate('globalSearch.results')}>
        {view.error && <ReadFailedLine className="px-3 py-2" message={view.error.message} onRetry={view.error.retry} />}
        {hasQuery && view.taskIndex?.state === 'preparing' && (facet === 'all' || facet === 'task') && (
          <div role="status" className="px-3 py-3 text-sm text-foreground/50">{view.taskIndex.total
            ? translate('globalSearch.indexingTasksProgress', { percent: Math.floor(100 * (view.taskIndex.done ?? 0) / view.taskIndex.total) })
            : translate('globalSearch.indexingTasks')}</div>
        )}
        {hasQuery && view.taskIndex?.state === 'failed' && (facet === 'all' || facet === 'task') && (
          <div role="alert" className="px-3 py-3 text-sm text-[var(--em-foreground-destructive)]">{translate('globalSearch.indexingTasksFailed')}</div>
        )}
        {!hasQuery && (names || filtersOpen) && (
          <>
          {/* The phone page lists the types one per row, every label on one line. */}
          {names && <SectionLabel className="px-3 pt-4">{translate('globalSearch.byType')}</SectionLabel>}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(max(8em,calc((100%_-_0.5rem)/3)),1fr))] gap-1 border-t border-foreground/[0.08] px-1 pt-2 text-[length:var(--font-body)] max-sm:flex max-sm:flex-col max-sm:gap-0 max-sm:border-t-0 max-sm:pt-0" data-testid="global-search-quick">
            {quick.filter((item) => !item.scoped || inChat).map((item) => (
              <span key={item.key} className="relative">
                <button type="button" data-quick={item.key} onClick={(event) => item.run(event.currentTarget)}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[length:var(--font-body)] text-foreground/75 hover:bg-foreground/[0.06] max-sm:min-h-14 max-sm:gap-4 max-sm:text-[length:var(--font-title)] max-sm:text-foreground">
                  <span className="text-foreground/45 max-sm:grid max-sm:size-8 max-sm:shrink-0 max-sm:place-items-center max-sm:rounded-[10px] max-sm:bg-foreground/[0.06] max-sm:text-foreground max-sm:[&>svg]:size-5">{item.icon}</span>{item.label}
                </button>
                {item.key === 'date' && <input type="date" aria-label={item.label} tabIndex={-1} className="pointer-events-none absolute inset-0 opacity-0"
                  onChange={(event) => { setDateNote(null); jumpToDay(event.currentTarget.value).catch((error: unknown) => setDateNote(messageForUser(error))) }} />}
              </span>
            ))}
          </div>
          </>
        )}
        {!hasQuery && dateNote && <div role="status" className="px-3 pt-2 text-sm text-foreground/50">{dateNote}</div>}
        {!hasQuery && recent.length > 0 && (
          <div className="px-1 pt-3" data-testid="global-search-recent">
            <div className="flex items-center justify-between px-3 pb-1 text-xs text-foreground/40">
              <span>{translate(inChat ? 'globalSearch.recentHere' : 'globalSearch.recent')}</span>
              <button type="button" data-testid="global-search-recent-clear" className="-my-2 -mr-2 min-h-9 px-2 hover:text-foreground/70 max-sm:min-h-11"
                onClick={() => { forgetSearches(recentScope); setForgotten((count) => count + 1) }}>{translate('globalSearch.clearRecent')}</button>
            </div>
            {recent.map((words) => (
              <button type="button" key={words} onClick={() => updateSearchSession({ text: words, selectedId: null })}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground/75 hover:bg-foreground/[0.06] max-sm:min-h-11">
                <History size={14} className="text-foreground/40" />{words}
              </button>
            ))}
          </div>
        )}
        {hasQuery && view.unresolved && <div className="px-3 py-8 text-center text-sm text-foreground/45">{translate('globalSearch.unresolved', { text: view.unresolved })}</div>}
        {nameRows.length > 0 && (
          <div data-testid="global-search-names">
            <SectionLabel>{translate(desktop ? 'globalSearch.nameMatches' : 'globalSearch.names')}</SectionLabel>
            {nameRows.map((row) => (
              <button key={row.id} type="button" data-testid="global-search-name" data-id={desktop ? row.id : row.id.slice(row.id.indexOf(':') + 1)}
                role={desktop ? 'option' : undefined} aria-selected={desktop ? row.id === selection : undefined}
                ref={row.id === selection ? selectedNameRef : undefined}
                onMouseMove={desktop ? () => { if (row.id !== selection) updateSearchSession({ selectedId: row.id }) } : undefined}
                onClick={() => openName(row)}
                className={cn('gg-list-row gg-row max-sm:min-h-11', row.id === selection && 'bg-foreground/[0.06]')}>
                <ListRowContent leading={row.leading} title={<Highlighted text={row.name} query={view.query} />} />
                {row.subtitle && <span className="ml-auto shrink-0 pr-1 text-xs text-foreground/45">{row.subtitle}</span>}
              </button>
            ))}
          </div>
        )}
        {titleError && <ReadFailedLine className="px-3 py-2" message={translate('palette.searchFailed')} onRetry={retryOf(titles)} />}
        {hasQuery && !view.unresolved && view.hits === null && !view.error && (
          <div data-testid="global-search-pending">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex w-full items-start gap-[var(--row-gap)] px-2 py-2">
                <Unknown className="mt-1 h-5 w-5 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 text-sm leading-5"><Unknown className="w-3/4" /><span className="mt-1 block text-xs"><Unknown className="w-24" /></span></span>
              </div>
            ))}
          </div>
        )}
        {hasQuery && !view.unresolved && !view.loading && !view.error && view.hits !== null && !titlePending && !titleError && ordered.length === 0 && nameRows.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-sm text-foreground/45">
            <span>{view.query ? translate('globalSearch.emptyFor', { text: view.query }) : translate('globalSearch.typeWords')}</span>
            {view.query && (facet !== 'all' || chips.length > 0) && (
              <button type="button" className="text-[length:var(--font-body)] text-foreground/70 underline-offset-4 hover:underline"
                onClick={() => updateSearchSession({ facet: 'all', chips: [], selectedId: null })}>{translate('globalSearch.widen')}</button>
            )}
          </div>
        )}
        <GrowingList
          scroller={list}
          count={lines.length}
          getKey={(index) => { const line = lines[index]!; return line.kind === 'hit' ? line.hit.id : `scope:${line.group.key}` }}
          estimateSize={(index) => { const line = lines[index]!; return line.kind === 'hit' ? hitHeight(line.hit.text, list) : SCOPE_LINE_HEIGHT }}
          windowRef={(lineWindow) => { lineWindowRef.current = lineWindow }}
          renderLine={(index) => {
            const line = lines[index]!
            if (line.kind === 'scope') {
              const { group } = line
              return (
                <button type="button" data-search-scope="" title={translate('globalSearch.scopeTo')}
                  className="flex w-full items-center gap-2 px-2 pb-1 pt-3 text-left text-xs text-foreground/45 hover:text-foreground/70"
                  onClick={() => setChips([...chips, group.scope])}>
                  <span className="truncate font-medium">{group.label}</span>
                  {group.task && <span className="shrink-0 text-foreground/35"> {translate('globalSearch.task')}</span>}
                </button>
              )
            }
            const { hit } = line
            const isSelected = hit.id === selected?.id
            const sender = hit.kind === 'message' ? hit.sender ?? translate('globalSearch.system') : translate(hit.role === 'assistant' || hit.activity ? 'globalSearch.agent' : 'globalSearch.you')
            return (
              <button type="button" role="option" aria-selected={isSelected} data-selected={isSelected}
                onMouseMove={() => { if (!isSelected) updateSearchSession({ selectedId: hit.id }) }}
                onClick={() => open(hit)}
                className={cn('flex w-full items-start gap-[var(--row-gap)] rounded-lg px-2 py-2 text-left outline-none', isSelected && 'bg-foreground/[0.06]')}>
                <ResultAvatar hit={hit} name={sender} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm leading-5 text-foreground/85"><Highlighted text={hit.text} query={view.query} /></span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-foreground/40">
                    <span className="truncate">{sender}</span>
                    <span className="shrink-0 tabular-nums">{formatWhen(hit.at)}</span>
                  </span>
                </span>
                {isSelected && <span className="mt-1 shrink-0 text-foreground/35 max-sm:hidden"><Shortcut hotkey="Enter" variant="keycaps" /></span>}
              </button>
            )
          }}
        />
      </div>

      {hasQuery && view.elsewhere && chips.some((chip) => chip.kind === 'in') && (
        <button type="button" data-testid="global-search-elsewhere" onClick={() => setChips(chips.filter((chip) => chip.kind !== 'in'))}
          className="flex shrink-0 items-center border-t border-foreground/[0.08] px-4 py-2 text-left text-[length:var(--font-body)] text-foreground/60 hover:text-foreground">
          {translate('globalSearch.elsewhere', { count: view.elsewhere.capped ? `${view.elsewhere.count}+` : String(view.elsewhere.count) })}
        </button>
      )}
      {desktop && (
        <div data-modal-resize="" data-testid="global-search-resize" aria-hidden="true"
          className="window-no-drag-region group ml-auto flex h-3 w-6 shrink-0 cursor-nwse-resize touch-none items-end justify-end pr-1.5 pb-1">
          <span className="size-2 rounded-br-sm border-r border-b border-foreground/35 group-hover:border-foreground/70" />
        </div>
      )}
    </div>
  )
}
