import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { inferAttachmentKind } from '@gugu/core/shared/ui/attachmentModels'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { PaneHeader } from '@/components/ui/Pane'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { Avatar } from '@/components/Avatar'
import { ChatAreaPanel } from '@/components/ChatAreaPanel'
import { FilePreviewHost } from '@/components/chat/filePreviewHost'
import { AssistantComposerEntries } from '@/components/assistant/AssistantComposerEntries'
import { useCustomizeCardOffered } from '@/lib/assistantSetupState'
import { useAuth } from '@/store/auth'
import type { AssistantChatHandlers } from '@/components/assistant/AssistantChatSlot'
import { useAssistantTyping } from '@/components/assistant/useAssistantTyping'
import { AssistantConversationProgress } from '@/components/assistant/AssistantConversationProgress'
import { useBackLayer } from '@/components/ui/sheetStack'
import type { AssistantHomePlace } from '@/lib/assistantHome'
import { assistantTintHue, assistantTintStyle } from '@/lib/assistantTint'
import { scheduleComposerFocus } from '@/lib/focusComposer'
import { ArrowUpToLine, ChevronLeft, Mic, Paperclip, Search, Sparkles } from '@/lib/icons'
import { useReportChatOnScreen } from '@/lib/onScreenChat'
import { UI_EVENTS } from '@/lib/uiEvents'
import { searchInChat } from '@renderer/features/global-search/search-session'
import { showAssistantTaskChat, useOpenedAssistantTaskChat } from '@/lib/assistantTaskChat'
import { ShellSlot } from '@/session/renderer/features/assistant/assistant-shell'
import { useChatStore } from '@/store/chatContext'
import { ChatLineScope } from '@/store/chatLineScope'
import { useAssistantPanelPage } from '@/lib/assistantPanelPage'
import { PhoneHomeContext } from './phoneHome'
import { PhoneAppFrame } from '@/components/appSlot/PhoneAppFrame'
import { phoneAssistantLayer } from '@/components/appSlot/phoneAssistantLayer'
import { requestAssistantClose } from '@/lib/assistantClose'
import { ASSISTANT_APP_ID, type AssistantLayerEntry } from '@/session/shared/extensions/assistant-entry'
import type { PhoneAssistantScreen, PhoneSurfaceSection } from '@/session/shared/extensions/phone-binding'
import type { AppSurfaceIntent } from '@/session/shared/extensions/unread-binding'
import { PhoneConfirmDialog } from './PhoneConfirmDialog'
import { usePhoneAssistantAppStuck } from '@/components/appSlot/phoneAssistantAppEnsure'
import { phoneInstalledApp } from '@/components/appSlot/phoneBindingPorts'
import { personsOwnAssistantApp } from '../../../electron/assistant-app-ensure'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { PHONE_ASSISTANT_LAYER_TAB, usePhoneAssistantEntry } from './phoneAssistantEntry'
import { PhoneAssistantWorkLedger } from './PhoneAssistantWorkLedger'
import { PhoneAssistantCountsSource } from './PhoneAssistantCounts'
import { phoneWorkChats } from './phoneWorkChats'
import { useContactsStore } from '@/store/contactsContext'
import { PhoneIdeas } from './PhoneIdeas'
import { PhoneMemory } from './PhoneMemory'
import { PhoneProfile } from './PhoneProfile'
import { phoneNextRoute, phoneParentRoute, type PhoneParentRoute } from './phoneRoutes'
import { PhoneVoiceBar } from './PhoneVoiceBar'
import { usePhoneVoiceNotes } from './phoneVoiceRuntime'
import { usePhoneMachine, type PhoneMachineState } from './phoneMachine'
import '@/session/renderer/features/assistant/assistant-today.css'
import './assistant-phone.css'

export const PHONE_TABS = ['chat', 'today', 'tasks', 'memory', 'profile'] as const
export type PhoneTab = (typeof PHONE_TABS)[number]
/** 页头分段里的几格;「资料」不占一格,点页头它的头像就是(owner 10-26 改版稿)。 */
const PHONE_SEGMENTS = PHONE_TABS.filter((id) => id !== 'profile')
/** 此刻摆着哪一页:某一格(往下钻到 `sub`)。 */
export type PhoneRoute = PhoneParentRoute<PhoneTab>

export type PhoneAssistant = { id: string; display_name: string; avatar: string | null; created_at: string | null }

/** 每一格拿到的:是谁、它那条私聊、它家里那台此刻能不能读、往聊天里填一句(只填不发)、往下钻。 */
export type PhonePageProps = {
  assistant: PhoneAssistant
  chatId: string
  ownerName: string | null
  /** 它家那台的设备 id(住云上 = 云端宿主,住人自己的电脑 = 那台电脑):读它家里的东西都问这一台。 */
  homeDeviceId: string | null
  /** 云端宿主那台(没有 = null):设备列表里「别的设备」按它排除。 */
  cloudDeviceId: string | null
  /** 它住哪(云上 / 哪台电脑,那台在不在线)。 */
  home: AssistantHomePlace | null
  /** 读写它家里文件用的工作区(各格共用一份,❌ 每格各开一次)。 */
  machine: PhoneMachineState
  /** 把这句话(和要带上的文件)填进和它聊天的输入框并回到聊天:只填不发,人看过再发。 */
  askInChat: (draft: string, files?: File[]) => void
  /** 这一格往下钻到哪(名字与桌面面板同一套:`note:<文件名>`、`routine:<id>`、`connector:<id>`…);首页 = null。 */
  sub: string | null
  go: (sub: string | null) => void
  /** 换到别的格(或它的子页),例如「动态」页「来源」里的「管理连接」去 <名字> 那一格的连接应用。 */
  open: (route: PhoneRoute) => void
}

/** 往下钻的页的上一层(手机自己的一张表,见 phoneRoutes)。 */
function backOf(route: PhoneRoute): PhoneRoute | null {
  const parent = phoneParentRoute(route)
  return parent ? { tab: route.tab, sub: parent.sub } : null
}

/** 「分析健康报告」收的文件(与健康页同一份:报告多是 PDF 或拍照 / 截图)。 */
const HEALTH_REPORT_ACCEPT = 'application/pdf,image/*'

/**
 * #7199 手机上的助理 App:「消息」置顶第一行推进来的整屏一层,没有底栏(owner 10-26,OpenDCAI/gugu#446,取代 10-16「咕咕底栏一直在」)。
 * 默认是和它的聊天。页头一行(owner 10-26:「header 占一点 footer 占一点 中间没多少空间」):
 * 返回 · 它的头像(点了去「资料」,它自己的设置也在那里)· 分段 聊天 / 动态 / 任务 / 记忆 · 搜索聊天记录(聊天时)。
 * 往下钻的页左上返回回上一层,顶层的返回回「消息」;安卓返回键:往下钻的页回上一层,别的格回聊天,聊天再退回「消息」。
 * 聊天就是和它的那条私聊(对话列表点它也是切到这里),整套聊天面常驻(切到别的格只藏起来:草稿、滚动位置都在);只有聊天那一段摆在眼前才算「在看」。
 * 底色、卡片、字号读 `--ta-*`(助理主页收到咕咕自己的 token 上),手机里 ❌ 自己写颜色。
 */
function MobileAssistantAppContent({
  chatId,
  assistant,
  ownerName,
  homeDeviceId,
  cloudDeviceId,
  home,
  visible,
  chatRequest, navigationTarget,
  onExit,
  ...chatHandlers
}: {
  chatId: string
  assistant: PhoneAssistant
  ownerName: string | null
  homeDeviceId: string | null
  cloudDeviceId: string | null
  home: AssistantHomePlace | null
  /** 底栏此刻停在「助理」这一格:切到别的格时 App 只藏不卸(分页器里常驻),❌ 还算「在看」。 */
  visible: boolean
  /** 每变一次 = 别处打开了和它的私聊:落在聊天那一段。 */
  chatRequest: number
  navigationTarget?: boolean
  /** 顶层的返回:退回「消息」。 */
  onExit?: () => void
} & AssistantChatHandlers) {
  const { t } = useTranslation('assistant')
  const [route, setRoute] = useState<PhoneRoute>({ tab: 'chat' })
  // Its 连接应用 (or its settings, `detail.sub`), asked from elsewhere: a page of its profile here, never Settings (owner 11-12).
  useEffect(() => {
    const open = (event: Event) => {
      const sub = (event as CustomEvent<{ sub?: 'settings' | 'connectors' } | null>).detail?.sub === 'settings' ? 'settings' : 'connectors'
      setRoute({ tab: 'profile', sub })
    }
    window.addEventListener(UI_EVENTS.openAssistantConnectors,open)
    return () => window.removeEventListener(UI_EVENTS.openAssistantConnectors,open)
  },[])
  const open = useCallback((target: PhoneRoute) => {
    const next = phoneNextRoute(route, target)
    // The assistant already owns one phone layer. Internal routes update its
    // content without snapshotting and cross-fading the persistent header/chat.
    setRoute(next)
  }, [route])
  const tab = route.tab
  // API 49 The assistant's place (assistant-entry.ts): the product's assistant App fills every section but the conversation.
  const entry = usePhoneAssistantEntry()
  const app = entry.entry === 'app' ? entry : null
  // #1931 Until the App is in (phoneAssistantAppEnsure.ts puts it in by itself), 动态 / 任务 / 记忆 / 资料 say it is being
  // prepared — 聊天 works meanwhile; said stuck only once every try of the backoff window failed.
  const ensureStuck = usePhoneAssistantAppStuck()
  // An App with its id that is the person's own (from a chat, switched off): gugu does not put over it — stuck. gugu's own
  // market copy the phone does not trust is not: the ensure step puts the signed release over it (preparing meanwhile).
  const held = !app && installedExtensionsStore.isLoaded ? phoneInstalledApp(ASSISTANT_APP_ID) : null
  const appHeldElsewise = held !== null && personsOwnAssistantApp(held) !== null
  const opened = useOpenedAssistantTaskChat()
  useEffect(() => {
    if (opened?.request.assistantId === assistant.id) setRoute({ tab: 'tasks' })
  }, [opened, assistant.id])
  const taskChat = tab === 'tasks' && opened?.request.assistantId === assistant.id
  const sub = route.sub ?? null
  // The App's page shows the section the person is on; on 聊天 it stays where it was, hidden. A screen of the phone's own
  // (`sub`, opened for it: settings, look, devices…) is drawn over it.
  const appSection = useRef<PhoneSurfaceSection>('today')
  if (tab !== 'chat') appSection.current = tab
  const { user: signedIn } = useAuth()
  const ownerId = signedIn?.id ?? null
  const hostScreen = Boolean(app && sub)
  // API 50 `removeVoiceNote`: the layer's own question (the built-in note page's), answered yes or no.
  const [removal, setRemoval] = useState<{ title: string | null; answer: (yes: boolean) => void } | null>(null)
  const confirmRemoval = useCallback((question: { kind: 'voice-note'; title: string | null }) =>
    new Promise<boolean>((resolve) => setRemoval({ title: question.title, answer: resolve })), [])
  // What the person asked of the App's page here (the recording bar's note, the 自定义 card): told once the layer shows it.
  const [intent, setIntent] = useState<AppSurfaceIntent | null>(null)
  useLayerForApp(app, ownerId, visible, appSection.current, hostScreen, open, assistant.id, confirmRemoval, intent, () => setIntent(null))
  const pageBody = useRef<HTMLElement | null>(null)
  const pageScroll = useRef(new Map<string, number>())
  const pageKey = `${tab}:${sub ?? ''}`
  useLayoutEffect(() => {
    if (pageBody.current) pageBody.current.scrollTop = pageScroll.current.get(pageKey) ?? 0
  }, [pageKey])
  useEffect(() => {
    if (chatRequest > 0) setRoute({ tab: 'chat' })
  }, [chatRequest])
  const { writeDraft, draftAttachments, setDraftAttachments } = useChatStore('writeDraft', 'draftAttachments', 'setDraftAttachments')
  const attachmentsRef = useRef(draftAttachments)
  attachmentsRef.current = draftAttachments
  const [ideasOpen, setIdeasOpen] = useState(false)
  const [chatColumn, setChatColumn] = useState<HTMLDivElement | null>(null)
  const chatShown = useReportChatOnScreen(visible && tab === 'chat' ? chatId : null) === chatId
  const machine = usePhoneMachine(homeDeviceId, assistant.id, chatId)
  // 「+」里的「录制语音笔记」:手机只录和传到它家里(phoneVoiceRuntime),转写在电脑上点「开始转写」;上传失败时录音保留在手机上。
  const { t: tVoice } = useTranslation('voiceNotes')
  const voice = usePhoneVoiceNotes({ assistantId: assistant.id, deviceId: homeDeviceId, machine })
  const { disabled: voiceDisabled, start: voiceStart } = voice
  const back = backOf(route)
  const innerPage = useAssistantPanelPage()
  // 安卓返回键:往下钻的页回上一层,别的格回聊天,聊天再退出(交给外壳:退回「消息」)。
  useBackLayer(() => taskChat ? showAssistantTaskChat(null) : innerPage ? innerPage.back() : open(back ?? { tab: 'chat' }), visible && tab !== 'chat')

  // 「问问它」这类:回到聊天并唤起键盘(人要接着打字);点分段里的「聊天」只切过去,不弹键盘(手机壳惯例)。
  const openChat = useCallback(() => {
    open({ tab: 'chat' })
    scheduleComposerFocus('composer-open', { mobileShell: true })
  }, [open])
  const askInChat = useCallback(
    (draft: string, files?: File[]) => {
      if (draft) writeDraft(chatId, { at: 'end', text: draft })
      if (files?.length) {
        const queued = attachmentsRef.current[chatId] ?? []
        setDraftAttachments(chatId, [...queued, ...files.map((file) => ({ id: crypto.randomUUID(), file, kind: inferAttachmentKind(file) }))])
      }
      openChat()
    },
    [chatId, openChat, writeDraft, setDraftAttachments],
  )

  const name = assistant.display_name
  const typing = useAssistantTyping(chatId, assistant.id, name)
  const { user } = useAuth()
  const customizeOffered = useCustomizeCardOffered(user?.id)
  // 自定义 is the App's 资料 (name, look, character), told `profile` as a computer's header click tells it.
  const openCustomize = () => {
    open({ tab: 'profile' })
    if (app) setIntent({ kind: 'profile' })
  }
  const composerEntries = <AssistantComposerEntries assistantId={assistant.id} busy={false} onOpen={() => setIdeasOpen(true)}
    customize={customizeOffered && user?.id ? { ownerUserId: user.id, name, onOpen: openCustomize } : undefined} />
  // The recording bar's 「查看」: the App's 记忆, told `voice-note` (it reads the note through `voice-notes`).
  const openFromBar = (route: PhoneRoute) => {
    if (route.tab !== 'memory') return open(route)
    open({ tab: 'memory' })
    if (app) setIntent({ kind: 'voice-note' })
  }
  const reportInput = useRef<HTMLInputElement>(null)
  // 「+」里的:获取灵感(胶囊隐藏了也一直在)、录制语音笔记(正在录时置灰,录音条在聊天上面)、
  // 分析健康报告(选一份 PDF / 图片连同那句话排进输入框)。
  const attachMenu = useMemo(
    () => [
      { id: 'ideas', label: t('ideas.get'), icon: <Sparkles />, onSelect: () => setIdeasOpen(true) },
      { id: 'voice-note', label: tVoice('record'), icon: <Mic />, disabled: voiceDisabled, onSelect: voiceStart },
      { id: 'health-report', label: t('health.analyzeReport'), icon: <ArrowUpToLine />, onSelect: () => reportInput.current?.click() },
    ],
    [t, tVoice, voiceDisabled, voiceStart],
  )
  const page: PhonePageProps = { assistant, chatId, ownerName, homeDeviceId, cloudDeviceId, home, machine, askInChat, sub, go: (next) => open({ tab, sub: next ?? undefined }), open }
  const labels: Record<PhoneTab, string> = { chat: t('nav.chat'), today: t('nav.today'), tasks: t('nav.tasks'), memory: t('nav.memory'), profile: t('nav.profile') }

  // 它的主题色(小鸟身体的色相;照片头像没有 = 不写,走咕咕默认色),落在 `.ta-phone` 根上整页重算。
  const tint = useMemo(() => assistantTintStyle(assistantTintHue(assistant.id, assistant.avatar)) as CSSProperties | undefined, [assistant.id, assistant.avatar])

  return (
    <PhoneHomeContext.Provider value={home}>
    <div className="ta-phone" data-testid="mobile-assistant-app" data-tab={tab} data-sub={sub ?? ''} style={tint}>
      {/* 页头一行,与「消息」「伙伴」同一个 PaneHeader:返回(往下钻的页回上一层,顶层回「消息」)· 它的头像(去「资料」)· 分段 · 搜索(聊天段)。 */}
      <PaneHeader
        mobile
        className="ta-phone-head"
        data-testid="mobile-assistant-header" hidden={taskChat}
        leading={
          <>
            {innerPage || back ? (
              <IconButton size="lg" aria-label={`${t('panel.back')} · ${labels[back?.tab ?? tab]}`} onClick={() => innerPage ? innerPage.back() : back && open(back)} data-testid="mobile-assistant-back">
                <ChevronLeft />
              </IconButton>
            ) : onExit ? (
              <IconButton size="lg" aria-label={t('panel.back')} onClick={onExit} data-testid="mobile-assistant-exit">
                <ChevronLeft />
              </IconButton>
            ) : null}
            <Button variant="ghost" className="ta-phone-identity" aria-pressed={tab === 'profile'} onClick={() => open({ tab: 'profile' })} aria-label={t('top.profile', { name })} data-testid="mobile-assistant-pill">
              <Avatar name={name} avatarUrl={assistant.avatar} seed={assistant.id} size={28} isAgent harnessBadge={false} />
            </Button>
          </>
        }
        title={
          <div className="ta-phone-seg">
            <SegmentedTabs
              ariaLabel={name}
              value={tab}
              onChange={(id) => { showAssistantTaskChat(null); open({ tab: id }) }}
              items={PHONE_SEGMENTS.map((id) => ({ value: id, label: labels[id], panelId: `assistant-${assistant.id}-${id}`, testId: `mobile-assistant-tab-${id}` }))}
            />
          </div>
        }
        actions={(
          <IconButton size="lg" hidden={tab !== 'chat'} aria-label={t('top.search')} onClick={() => searchInChat(chatId)} data-testid="mobile-assistant-search">
            <Search />
          </IconButton>
        )}
      />
      <div id={`assistant-${assistant.id}-chat`} role="tabpanel" aria-label={labels.chat} className="ta-phone-chat ta-chat" hidden={tab !== 'chat'} ref={setChatColumn}>
        <FilePreviewHost.Provider value={{}}><ChatAreaPanel viewportKey="assistant"
          chatId={chatId}
          navigationTarget={navigationTarget}
          mobile
          hidden={!chatShown}
          chrome={{ placeholder: t('chat.placeholder', { name }), attachGlyph: <Paperclip />, attachMenu, typing, composerHeader: composerEntries, hideRunningStatus: true }}
          {...chatHandlers}
        /></FilePreviewHost.Provider>
      </div>
      {/* 录音条:在 App 根上而不是聊天那一段里 —— 切到别的格也看得到「还在录」。 */}
      <PhoneVoiceBar voice={voice} name={name} column={chatColumn} onChat={tab === 'chat'} open={openFromBar} />
      <PhoneConfirmDialog
        open={removal !== null}
        title={tVoice('deleteTitle', { name: removal?.title || tVoice('untitled') })}
        body={tVoice('deleteBody')}
        confirmLabel={tVoice('delete')}
        failedText={tVoice('deleteFailed')}
        testId="mobile-assistant-voice-delete-dialog"
        onConfirm={async () => removal?.answer(true)}
        onClose={() => { removal?.answer(false); setRemoval(null) }}
      />
      <input
        ref={reportInput}
        type="file"
        accept={HEALTH_REPORT_ACCEPT}
        className="hidden"
        data-testid="mobile-assistant-health-report-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          if (files.length > 0) askInChat(t('health.healthReportMessage'), files)
        }}
      />
      {ideasOpen ? <PhoneIdeas assistant={assistant} chatId={chatId} askInChat={askInChat} onClose={() => setIdeasOpen(false)} /> : null}
      {app ? (
        <div className="ta-phone-app" data-testid="mobile-assistant-app-page" hidden={tab === 'chat' || taskChat || hostScreen}>
          <PhoneAppFrame kind={app.tabKind} tabId={PHONE_ASSISTANT_LAYER_TAB} chatId={null} hidden={tab === 'chat' || taskChat || hostScreen}
            onOpenWith={() => undefined} testId="mobile-assistant-app-frame" missingTestId="mobile-assistant-app-missing" />
        </div>
      ) : null}
      {app ? <PhoneAssistantWorkLedger ownerId={ownerId} assistantId={assistant.id} /> : null}
      {app && ownerId ? <PhoneAssistantCountsSource ownerId={ownerId} assistantId={assistant.id} machine={machine} cloudDeviceId={cloudDeviceId} /> : null}
      {tab === 'chat' || (app && !hostScreen) ? null : (
        <main id={`assistant-${assistant.id}-${tab}`} role="tabpanel" aria-label={labels[tab]} className="ta-phone-body" ref={pageBody} onScroll={(event) => pageScroll.current.set(pageKey, event.currentTarget.scrollTop)} data-testid={`mobile-assistant-${tab}`} hidden={taskChat}>
          {/* The App's page fills each section; under it only the phone's own screens it opens (PHONE_ASSISTANT_SCREENS). */}
          {!app && !sub ? <AppPreparing stuck={ensureStuck || appHeldElsewise} /> : <>
            {tab === 'memory' ? <PhoneMemory {...page} /> : null}
            {tab === 'profile' ? <PhoneProfile {...page} /> : null}
          </>}
        </main>
      )}
      {taskChat ? <ShellSlot name="task-chat" className="ta-task-chat-slot" /> : null}
    </div>
    </PhoneHomeContext.Provider>
  )
}

/**
 * A section before the assistant App is in: the gate's own waiting line (正在准备你的咕咕…); once every try failed, the one
 * statement of why (an App with its id that gugu does not put over, switched off, or the market out of reach) — in place, no
 * toast, no button: it goes on by itself.
 */
function AppPreparing({ stuck }: { stuck: boolean }) {
  const { t } = useTranslation('assistant')
  const main = useTranslation('main').t
  return (
    <div className="ta-phone-gate" data-testid="mobile-assistant-app-preparing" data-stuck={stuck || undefined}>
      <div className="ta-intro">
        {stuck ? <>
          <h1 className="ta-intro-title">{main('assistantRules.stuckTitle')}</h1>
          <p className="ta-intro-body">{main('assistantRules.stuckBody')}</p>
        </> : (
          <p className="ta-intro-body inline-flex items-center gap-2" role="status">
            <LoadingIndicator size="inline" />
            {t('railEntry.preparing')}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * While the layer is up with the App's page in it: the binding host hears which section the page fills (null when the layer
 * is not on screen), and the layer does what the page asks — move to a section, open one of the phone's own screens for the
 * assistant (PHONE_ASSISTANT_SCREENS), draw a task's conversation over 任务.
 */
function useLayerForApp(app: Extract<AssistantLayerEntry, { entry: 'app' }> | null, ownerId: string | null, visible: boolean,
  section: PhoneSurfaceSection, hostPage: boolean, open: (route: PhoneRoute) => void, assistantId: string,
  confirmRemoval: (question: { kind: 'voice-note'; title: string | null }) => Promise<boolean>,
  intent: AppSurfaceIntent | null, told: () => void) {
  const extensionId = app?.extensionId ?? null
  useEffect(() => {
    phoneAssistantLayer.report(extensionId && ownerId && visible ? { ownerId, extensionId, tabId: PHONE_ASSISTANT_LAYER_TAB, section, hostPage } : null)
  }, [extensionId, ownerId, visible, section, hostPage])
  // After the report above (effects run in order): the page hears the intent in the section it is now shown in.
  useEffect(() => {
    if (!intent || !extensionId || !ownerId || !visible || hostPage) return
    phoneAssistantLayer.tell(intent)
    told()
  }, [intent, extensionId, ownerId, visible, section, hostPage, told])
  useEffect(() => () => phoneAssistantLayer.report(null), [])
  const openRef = useRef(open)
  openRef.current = open
  const { updateAgentProfile } = useContactsStore()
  const renameRef = useRef(updateAgentProfile)
  renameRef.current = updateAgentProfile
  const confirmRef = useRef(confirmRemoval)
  confirmRef.current = confirmRemoval
  useEffect(() => {
    if (!extensionId) return undefined
    return phoneAssistantLayer.provide({
      rename: async (agentId, name) => {
        if (agentId !== assistantId) throw Object.assign(new Error('Not this layer\'s assistant'), { code: 'denied' })
        await renameRef.current(agentId, { name })
      },
      move: (next) => { showAssistantTaskChat(null); openRef.current({ tab: next }) },
      open: (screen: PhoneAssistantScreen) => {
        if ('confirm' in screen) requestAssistantClose()
        else if ('connectors' in screen) openRef.current({ tab: 'profile', sub: 'connectors' })
        else openRef.current({ tab: screen.section, sub: screen.page })
      },
      openWork: (work) => { phoneWorkChats.open(assistantId, work) },
      confirmRemoval: (question) => confirmRef.current(question),
    })
  }, [extensionId, assistantId])
}

export function MobileAssistantApp(props: Parameters<typeof MobileAssistantAppContent>[0]) {
  return <ChatLineScope chatId={props.chatId}><AssistantConversationProgress assistantId={props.assistant.id} chatId={props.chatId} visible={props.visible}>
    <MobileAssistantAppContent {...props} />
  </AssistantConversationProgress></ChatLineScope>
}
