import { useRef, useState, type ReactNode } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { Hash, Users, ChevronRight } from '@/lib/icons'
import { followLink } from '@/lib/guguLinks'
import { PhoneComposerControl, PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { preserveComposerFocus } from '../composer/composer-focus'
import { openPhoneSidebarSession } from './phone-sidebar-navigation'
import { CreateTarget, type ExistingSessionModel } from '../agent-watch/CreateTarget'
import type { creationSkillInput } from '../agent-watch/create-skill-draft'
import { engineLabel } from '@/lib/usage/engineLabel'
import type { PhoneSessionSidebarModel } from './usePhoneSessionSidebar'
import './room-composer-catalog'
import './phone-room-composer.css'
import { phoneMenuBar } from '../composer/phone-menu-bar'
import { PhoneNavigationPicker } from './PhoneNavigationPicker'

export const PhoneSessionSidebarControls = observer(function PhoneSessionSidebarControls({ sidebar, model, skillDraft, nativeSkills }: { sidebar: PhoneSessionSidebarModel; modelControl?: ReactNode; model?: ExistingSessionModel; skillDraft?: ReturnType<typeof creationSkillInput>; nativeSkills?: ReactNode }) {
  const { t } = useTranslation('mobileRoomControls')
  const { anchor, listed, directory, devices, identitiesById, families, source, topics, sessionId } = sidebar
  const agentsButton = useRef<HTMLButtonElement>(null)
  const topicsButton = useRef<HTMLButtonElement>(null)
  const current = directory.find(row => row.session.conversationId === sessionId)
  const device = devices.find(one => one.device_id === current?.deviceId)
  const machine = device ? { device, localProjectId: current?.session.projectId ?? '', path: '', available: device.is_online } : undefined
  const harness = current?.session.harness ?? null
  const [view, setView] = useState<'agents' | 'topics' | null>(null)
  const menu = phoneMenuBar(source ? 'roomAgent' : 'agent', { topics: !!source, agents: listed.length > 0 })
  const nextEntry = !anchor ? null : anchor.kind === 'agent' ? `session:${families.topLevelOf.get(anchor.agentUserId)?.[0]?.id ?? sessionId}` : `chat:${anchor.chatId}`
  const agents = view === 'agents' ? listed.map(agent => {
    const row = directory.find(row => row.session.conversationId === agent.id)
    const identity = identitiesById[agent.agentUserId ?? '']
    return { agent, identity, name: identity?.display_name ?? row?.session.title ?? '' }
  }) : []
  return <div className="gg-phone-room-controls" data-testid="phone-session-sidebar-controls" data-anchor-kind={anchor?.kind} data-anchor-chat={anchor?.chatId}>
    <CreateTarget projects={[]} project={null} onProject={() => {}} machines={machine ? [machine] : []} machine={machine} onMachine={() => {}} machineLabel={one => one.label ?? one.hostname ?? ''} busy={false}
      existingSession={{ agentName: harness ? engineLabel(harness) : '', model }}
      configuration={{ options: null, selection: { harness, model: null, effort: null, permissionMode: null }, onChange: () => {}, models: null, modelsState: 'ready', skills: skillDraft?.skills ?? [], onSkills: next => skillDraft?.update(next) }}
      controlsExtra={<>
      {nativeSkills}
      {menu.includes('topics') && <PhoneComposerControl label={t('topics')} menuExpanded={view === 'topics'} testId="phone-room-topics" buttonRef={topicsButton} onClick={() => setView('topics')} />}
      {menu.includes('agents') && <PhoneComposerControl label={t('agents')} icon={<Users />} menuExpanded={view === 'agents'} testId="phone-room-agents" buttonRef={agentsButton} onClick={() => setView('agents')} />}
      </>} />
    <PhoneComposerSheet open={view !== null} onClose={() => setView(null)} title={t(view ?? 'agents')} testId="phone-room-controls-sheet" className="gg-phone-room-sheet" anchor={view === 'topics' ? topicsButton : agentsButton}>
      {view === 'agents' ? <PhoneNavigationPicker key={`agents:${sessionId}`} kind="agents" items={agents} nameOf={row => row.name}>
        {shown => shown.map(({ agent, identity, name }) => <Button key={agent.id} variant="ghost" className="gg-phone-room-choice gg-phone-room-agent" data-testid="phone-sidebar-agent" data-session-id={agent.id}
          onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus}
          onClick={() => { if (openPhoneSidebarSession(agent.id, nextEntry ?? undefined)) setView(null) }}>
          <Avatar name={name} seed={agent.agentUserId ?? agent.id} avatarUrl={identity?.avatar} isAgent size={36} />
          <span className="gg-phone-room-choice-name">{name}</span><ChevronRight aria-hidden />
        </Button>)}
      </PhoneNavigationPicker> : view === 'topics' ? <PhoneNavigationPicker key={`topics:${source}`} kind="topics"
        items={[null, ...(topics.topics ?? [])]} nameOf={topic => topic?.name ?? t('main')} ready={topics.topics !== null && !topics.error}>
        {shown => <>
          {shown.map(topic => topic ? <Button key={topic.chat_id} variant="ghost" className="gg-phone-room-choice" data-topic-id={topic.chat_id}
            onClick={() => { setView(null); followLink({ kind: 'chat', chatId: topic.chat_id }) }}><Hash /><span className="gg-phone-room-choice-name gg-phone-room-topic-name">{topic.name}</span></Button>
            : <Button key="main" variant="ghost" className="gg-phone-room-choice" onClick={() => { setView(null); if (source) followLink({ kind: 'chat', chatId: source }) }}>{t('main')}</Button>)}
          {topics.topics === null && !topics.error && <p role="status" className="gg-phone-composer-sheet-status">{t('loadingTopics')}</p>}
          {topics.error && <div role="alert">{topics.error}<Button variant="ghost" onClick={topics.reload}>{t('retry')}</Button></div>}
        </>}
      </PhoneNavigationPicker> : null}
    </PhoneComposerSheet>
  </div>
})
