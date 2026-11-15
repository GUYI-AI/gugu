import { useRef, useState, type ReactNode } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { useChatStore } from '@/store/chatContext'
import { Hash, Users, ChevronRight } from '@/lib/icons'
import { followLink } from '@/lib/guguLinks'
import { PhoneComposerControl, PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { preserveComposerFocus } from '../composer/composer-focus'
import { openPhoneSidebarSession } from './phone-sidebar-navigation'
import { CreateTarget, type ExistingSessionModel } from '../agent-watch/CreateTarget'
import type { useCreationSkillDraft } from '../agent-watch/create-skill-draft'
import { engineLabel } from '@/lib/usage/engineLabel'
import type { PhoneSessionSidebarModel } from './usePhoneSessionSidebar'
import './room-composer-catalog'
import './phone-room-composer.css'
import { PhoneCreateAgentAction } from '../composer/PhoneCreateAgentAction'
import { requestPhoneAgentCreation } from '../agent-watch/phone-agent-creation'
import { PhoneTopicChoice } from './PhoneTopicChoice'
import { roomTopicChoices } from './room-composer-models'

export const PhoneSessionSidebarControls = observer(function PhoneSessionSidebarControls({ sidebar, model, skillDraft }: { sidebar: PhoneSessionSidebarModel; modelControl?: ReactNode; model?: ExistingSessionModel; skillDraft?: ReturnType<typeof useCreationSkillDraft> }) {
  const { t } = useTranslation('mobileRoomControls')
  const { chats } = useChatStore('chats')
  const { anchor, listed, directory, devices, identitiesById, families, source, topics, sessionId } = sidebar
  const agentsButton = useRef<HTMLButtonElement>(null)
  const topicsButton = useRef<HTMLButtonElement>(null)
  const current = directory.find(row => row.session.conversationId === sessionId)
  const device = devices.find(one => one.device_id === current?.deviceId)
  const machine = device ? { device, localProjectId: current?.session.projectId ?? '', path: '', available: device.is_online } : undefined
  const harness = current?.session.harness ?? null
  const [view, setView] = useState<'agents' | 'topics' | null>(null)
  if (!anchor) return null
  const choices = roomTopicChoices(anchor.chatId, topics.topics ?? [], chats)
  const createAgent = () => { setView(null); requestPhoneAgentCreation(anchor.kind === 'agent' ? undefined : anchor.chatId) }
  const nextEntry = anchor.kind === 'agent' ? `session:${families.topLevelOf.get(anchor.agentUserId)?.[0]?.id ?? sessionId}` : `chat:${anchor.chatId}`
  return <div className="gg-phone-room-controls" data-testid="phone-session-sidebar-controls" data-anchor-kind={anchor.kind} data-anchor-chat={anchor.chatId}>
    <CreateTarget projects={[]} project={null} onProject={() => {}} machines={machine ? [machine] : []} machine={machine} onMachine={() => {}} machineLabel={one => one.label ?? one.hostname ?? ''} busy={false}
      existingSession={{ agentName: harness ? engineLabel(harness) : '', model, onCreateAgent: anchor.kind === 'project' ? createAgent : undefined }}
      configuration={{ options: null, selection: { harness, model: null, effort: null, permissionMode: null }, onChange: () => {}, models: null, modelsState: 'ready', skills: skillDraft?.skills ?? [], onSkills: next => skillDraft?.update(next) }}
      controlsExtra={<>
      {source && <PhoneComposerControl label={t('topics')} icon={<Hash />} testId="phone-room-topics" buttonRef={topicsButton} onClick={() => setView('topics')}
        badge={choices.unreadCount > 0 ? <Chip shape="count" tone="danger" aria-label={t('unread', { count: choices.unreadCount })}>{choices.unreadCount.toLocaleString()}</Chip> : undefined} />}
      <PhoneComposerControl label={t('agents')} icon={<Users />} testId="phone-room-agents" buttonRef={agentsButton} onClick={() => setView('agents')} />
      </>} />
    <PhoneComposerSheet open={view !== null} onClose={() => setView(null)} title={t(view ?? 'agents')} testId="phone-room-controls-sheet" className="gg-phone-room-sheet" anchor={view === 'topics' ? topicsButton : agentsButton}>
      {view === 'agents' ? <>
        {anchor.kind !== 'project' && <PhoneCreateAgentAction onCreate={createAgent} />}
        {listed.map(agent => {
        const row = directory.find(row => row.session.conversationId === agent.id)
        const identity = identitiesById[agent.agentUserId ?? '']
        const name = identity?.display_name ?? row?.session.title ?? ''
        return <Button key={agent.id} variant="ghost" className="gg-phone-room-choice gg-phone-room-agent" data-testid="phone-sidebar-agent" data-session-id={agent.id}
          onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus}
          onClick={() => { if (openPhoneSidebarSession(agent.id, nextEntry)) setView(null) }}>
          <Avatar name={name} seed={agent.agentUserId ?? agent.id} avatarUrl={identity?.avatar} isAgent size={36} />
          <span className="gg-phone-room-choice-name">{name}</span><ChevronRight aria-hidden />
        </Button>
      })}</> : view === 'topics' ? <div role="radiogroup" aria-label={t('topics')}>
        <PhoneTopicChoice name={t('main')} unread={choices.mainUnread} selected={false} main onClick={() => { setView(null); followLink({ kind: 'chat', chatId: anchor.chatId }) }} />
        {topics.topics === null && !topics.error && <p role="status" className="gg-phone-composer-sheet-status">{t('loadingTopics')}</p>}
        {choices.topics.map(topic => <PhoneTopicChoice key={topic.chat_id} name={topic.name} unread={topic.unread} selected={false} id={topic.chat_id}
          onClick={() => { setView(null); followLink({ kind: 'chat', chatId: topic.chat_id }) }} />)}
        {topics.error && <div role="alert">{topics.error}<Button variant="ghost" onClick={topics.reload}>{t('retry')}</Button></div>}
      </div> : null}
    </PhoneComposerSheet>
  </div>
})
