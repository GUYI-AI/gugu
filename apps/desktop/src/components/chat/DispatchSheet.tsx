import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@/session/shared/extensions/host-actions'
import type { DispatchPicked } from '@/session/shared/extensions/app-dispatch-core'
import { RESOURCE_TEMPLATES, type ResourceTemplate } from '@/session/shared/resource-actions'
import { Button } from '../ui/Button'
import { cn } from '@/lib/cn'
import { appendToDraft } from '@/store/chatDraftWrites'
import { useChatStore } from '../../store/chatContext'
import { rankMentionCandidates } from '@/lib/mentionRanking'
import { useAgentActivityMs } from '@/hooks/useAgentActivityMs'
import { personId } from '@/session/shared/extensions/app-runtime-protocol'
import { useProjectGroupMembers } from '@/lib/projectGroupChatsBridge'
import { useOwnedAgents } from '../settings/channels/channelAgents'
import { sendableConversations, sendablePickRows } from './forwardMessageUtils'
import { useAuth } from '../../store/auth'
import type { PromptEditorRef } from '@gugu/session-ui/react/components'
import { ChatPickSheet, type ChatPickRow, type ChatPickSection } from './ChatPickSheet'
import { NoteEditor } from './NoteEditor'
import { useGroupMentionProvider } from './useGroupMentionProvider'
import { DispatchMachine } from './DispatchMachine'
import { takeDispatchAsks, type DispatchAsked } from './dispatchAsk'

const NEW_AGENT = 'new:agent'

/**
 * The ask speaks as Apps do (`user:<uuid>`, personId); the chat's messages, members and agents, which the @ order reads,
 * go by the bare uuid. Rows are ranked and written under that one, and handed back in the App's spelling.
 */
const uuidOf = (id: string) => id.replace(/^user:/, '')

/**
 * Whom an App hands something to (`gugu.dispatch` naming no target), drawn by the shell over whatever is on screen
 * (ExtensionConsentSheet), so the view does not change for it. Above the rows: what will go — the text, which the person may
 * change (it goes as theirs), and each pill — and, for a member of a chat, whether the chat sees it. The rows are the
 * host's own: the page's chat's agents and people, the person's own agents (the page's own first; for a draft only those
 * with a session here), a new agent, chats (a draft). A pick (`ask.pick`, `gugu.pickAgent`) is the same sheet in the App's words: what it is about
 * read only, the person's own agents. Nothing goes before the press; the App hears only what was picked.
 */
export const DispatchSheet = observer(function DispatchSheet() {
  const { t } = useTranslation('messaging')
  const { chats, identitiesById, activeChatId, messages } = useChatStore('chats', 'identitiesById', 'activeChatId', 'messages')
  const projectMembers = useProjectGroupMembers()
  const owned = useOwnedAgents()
  const { user } = useAuth()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [asked, setAsked] = useState<DispatchAsked | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [visible, setVisible] = useState(false)
  const [spawnDevice, setSpawnDevice] = useState<string | null>(null)
  const open = useRef<DispatchAsked | null>(null)
  // What goes is written in the composer's own editor (NoteEditor): it starts with the App's words, theirs to change.
  // The editor comes up after the sheet does (and its handle again once TipTap is ready): it is started once per ask, when it can take the words.
  const editor = useRef<PromptEditorRef | null>(null)
  const started = useRef<DispatchAsked | null>(null)
  const start = useCallback(() => {
    const ask = open.current
    if (!ask || ask.pick || started.current === ask || !editor.current) return
    editor.current.setText(ask.text)
    if (!ask.text || !editor.current.isEmpty()) started.current = ask
  }, [])
  const editorRef = useCallback((handle: PromptEditorRef | null) => { editor.current = handle; start() }, [start])
  useEffect(start, [asked, start])
  const roster = useMemo(() => (asked?.chat?.members ?? []).map((member) => ({ id: uuidOf(member.id), name: member.name, type: member.kind })), [asked])
  const agentIds = useMemo(() => [...roster.filter((member) => member.type === 'agent').map((member) => member.id), ...owned.map((agent) => uuidOf(agent.id))], [roster, owned])
  const activityMs = useAgentActivityMs(agentIds, identitiesById)
  const { mentionProvider, renderMentionIcon } = useGroupMentionProvider({ chatId: asked?.chat?.id, isGroupChat: roster.length > 0, groupMembers: roster,
    currentUserId: user?.id ?? null, messages, enabled: !asked?.pick })

  // Answered once: by the person, by running out, or by the next ask taking the sheet.
  const finish = useCallback((picked: DispatchPicked) => {
    open.current?.answer(picked)
    open.current = null
    setAsked(null)
  }, [])
  useEffect(() => takeDispatchAsks((next) => {
    open.current?.answer(null)
    open.current = next
    setAsked(next)
    setSelected(new Set(next.offers.includes('my-agent') && next.preselect ? [`agent:${next.preselect}`] : []))
    setQuery('')
    setText(next.text)
    setVisible(next.visible)
    setSpawnDevice(next.spawnOn ?? null)
  }), [])
  // It waits on a person, as an install's consent does; main's clock (ipc-bridge) is the longer one.
  useEffect(() => {
    if (!asked) return
    const timer = setTimeout(() => finish(null), INSTALL_CONSENT_HUMAN_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [asked, finish])

  if (!asked) return null
  const needle = query.trim().toLocaleLowerCase()
  const offers = new Set(asked.offers)
  // Ranked as the chat's @ is: history counts only when the sheet is over that chat (or its topic).
  const here = chats.some((chat) => chat.id === activeChatId && (chat.id === asked.chat?.id || chat.source_chat_id === asked.chat?.id))
  const rank = <T extends { id: string; name: string; type: 'human' | 'agent' }>(rows: T[]) => rankMentionCandidates(rows, query, { chatId: here ? activeChatId : asked.chat?.id, currentUserId: user?.id, messages: here ? messages : [],
    participantIds: chats.find((chat) => chat.id === asked.chat?.id)?.member_user_ids, projectMemberIds: projectMembers.get(asked.chat?.id ?? ''), activityMs, now: Date.now() })
  const memberRows = (kind: 'agent' | 'human'): ChatPickRow[] => rank((asked.chat?.members ?? []).filter((member) => member.kind === kind).map((member) => ({ ...member, id: uuidOf(member.id), type: member.kind })))
    .map((member) => ({
      id: `member:${personId(member.id)}`,
      name: member.name,
      avatar: { name: member.name, avatarUrl: member.avatar, seed: personId(member.id), isAgent: member.kind === 'agent' },
    }))
  // The person's own agents: the one preselected first; a draft only into one whose session is here (its composer).
  const local = asked.local ? new Set(asked.local) : null
  const agentRows = !offers.has('my-agent') ? [] : rank(owned
    .map((agent) => ({ ...agent, id: uuidOf(agent.id), name: agent.display_name, type: 'agent' as const }))
    .filter((agent) => !asked.draft || !local || local.has(personId(agent.id))))
    .sort((a, b) => Number(personId(b.id) === asked.preselect) - Number(personId(a.id) === asked.preselect))
    .map((agent): ChatPickRow => ({
      id: `agent:${personId(agent.id)}`,
      name: agent.display_name,
      avatar: { name: agent.display_name, avatarUrl: agent.avatar, seed: personId(agent.id), isAgent: true },
    }))
  const nameOf = (chat: (typeof chats)[number]) => chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name)
  const chatRows = !offers.has('chat') ? [] : sendablePickRows(sendableConversations(chats, { ownerId: user?.id, query, displayName: nameOf, identitiesById }),
    nameOf, identitiesById, { expanded, searching: needle !== '', idOf: (id) => `chat:${id}` })
  const newRows: ChatPickRow[] = offers.has('new-agent') && (!needle || t('dispatchPick.newAgent').toLocaleLowerCase().includes(needle))
    ? [{ id: NEW_AGENT, name: t('dispatchPick.newAgent'), avatar: { name: '+', seed: NEW_AGENT, isAgent: true } }]
    : []
  const sections: ChatPickSection[] = [
    { id: 'chat-agents', title: t('dispatchPick.chatAgents', { chat: asked.chat?.name ?? '' }), rows: offers.has('agent-in-chat') ? memberRows('agent') : [] },
    { id: 'chat-people', title: t('dispatchPick.chatPeople', { chat: asked.chat?.name ?? '' }), rows: offers.has('person-in-chat') ? memberRows('human') : [] },
    { id: 'agents', title: t('dispatchPick.myAgents'), rows: agentRows },
    { id: 'new', title: t('dispatchPick.new'), rows: newRows },
    { id: 'chats', title: t('composePick.chats'), rows: chatRows },
  ]
  const [picked] = selected
  const listHidden = !asked.pick && !!picked && !query.trim()
  const toMember = picked?.startsWith('member:') === true
  const said = text.trim()
  const pickedTarget = (): NonNullable<DispatchPicked>['to'] | null => {
    if (!picked) return null
    if (picked === NEW_AGENT) return { new: true, ...(spawnDevice ? { device: spawnDevice } : {}) }
    const [kind, id = ''] = picked.split(/:(.*)/)
    if (kind === 'agent') return { agent: id }
    if (kind === 'member' && asked.chat) return { chat: asked.chat.id, member: id }
    return { chat: id }
  }
  // A pick: what it is about, read only, in the App's words — nothing is written to anyone.
  const pick = asked.pick
  // What will go, as it will read: the text (theirs to change) and each pill under it.
  const preview = pick ? (
    <div className="text-[length:var(--font-body)] text-[var(--text-primary)]" data-testid="dispatch-pick">
      {pick.subject}
      <p className="m-0 mt-1 text-[var(--text-secondary)]">{pick.body}</p>
    </div>
  ) : (
    <div className={cn('flex flex-col gap-[var(--spacing-xs)] border-t border-[var(--border-subtle)] !px-5 !py-3', listHidden ? 'min-h-0 flex-1' : 'shrink-0')} data-testid="dispatch-preview">
      <div className={cn('max-h-[60vh] min-h-[96px] overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1', listHidden && 'flex-1')} data-testid="dispatch-text">
        <NoteEditor editorRef={editorRef} onChange={setText} mentionProvider={mentionProvider} renderMentionIcon={renderMentionIcon}
          placeholder={t('dispatchPick.textPlaceholder')} inputTestId="dispatch-text-input" />
      </div>
      {asked.resource && <div className="flex flex-wrap gap-1" data-testid="dispatch-templates">
        {(RESOURCE_TEMPLATES[asked.resource.kind] as readonly ResourceTemplate[]).filter(template => template.requires?.every(fact => asked.resource?.facts?.includes(fact)) ?? true).map(template => (
          <Button key={template.id} size="sm" variant="ghost" onClick={() => editor.current?.setText(appendToDraft(editor.current.getText(), t(template.textKey)))}>{t(template.labelKey)}</Button>
        ))}
      </div>}
      {asked.pills.map((pill, index) => (
        <span key={index} className="truncate text-[length:var(--font-caption)] text-[var(--text-secondary)]" data-testid="dispatch-pill">@{pill}</span>
      ))}
      {picked === NEW_AGENT && asked.spawnOn !== undefined && <DispatchMachine deviceId={spawnDevice} onPick={setSpawnDevice} />}
      {!asked.draft && toMember && (
        <label className="flex items-center gap-[var(--spacing-xs)] text-[length:var(--font-caption)] text-[var(--text-secondary)]">
          <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} data-testid="dispatch-visible" />
          {t('dispatchPick.visible')}
        </label>
      )}
    </div>
  )
  return (
    <ChatPickSheet
      title={pick ? pick.title : asked.draft ? t('composePick.title') : t('dispatchPick.title')}
      onClose={() => finish(null)}
      testId="dispatch-sheet"
      rows={[]}
      sections={sections}
      above={pick ? preview : undefined}
      // Hand to: whom it goes to on top, what goes below in the composer's editor; once picked, the rows give it their room.
      below={pick ? undefined : preview}
      listHidden={listHidden}
      selected={selected}
      // One at a time: another row replaces the pick, the picked row (or its chip's ×) takes it back.
      onToggle={(id) => setSelected((current) => (current.has(id) ? new Set() : new Set([id])))}
      query={query}
      onQuery={setQuery}
      onMoreTopics={(id) => setExpanded((open) => new Set([...open, id.replace(/^chat:/, '')]))}
      placeholder={pick ? pick.search : t('dispatchPick.search')}
      empty={pick ? pick.empty : t('dispatchPick.empty')}
      actionLabel={pick ? pick.action : asked.draft ? t('composePick.action') : t('dispatchPick.send')}
      actionDisabled={!picked || (picked === NEW_AGENT && asked.spawnOn !== undefined && !spawnDevice) || (!pick && !said && asked.pills.length === 0)}
      onAction={() => {
        const to = pickedTarget()
        if (to) finish({ to, visible: toMember && visible, text: said })
      }}
    />
  )
})
