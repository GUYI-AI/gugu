import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { useState } from 'react'
import type { AgentAttention } from '@gugu/core/shared/agentStatus'
import { observer } from 'mobx-react-lite'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { platform } from '../platform'
import { installedExtensionsStore, type RailApp } from '../session/renderer/features/extensions/installed-extensions-store'
import { AppConversationUnread } from './extensionBundle/AppConversationUnread'
import { extensionSurfaceStore } from '../session/renderer/features/extensions/extension-surface-store'
import { appIsRunning, openApp, openAppInWindow, quitApp, setDock, unpinFromDock } from '../session/renderer/features/extensions/app-dock'
import { appState } from '../session/renderer/lib/stores/app-state'
import { returnToScreen } from '../session/renderer/app/screen-layout-actions'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { RailAppIcon } from './RailAppIcon'
import { UpdateBanner } from './UpdateBanner'
import { AUTOMATION_TEST_IDS, type AutomationTestId } from '../lib/automationDom'
import { HelpCircle, Library, Settings } from '@/lib/icons'
import { UI_EVENTS } from '../lib/uiEvents'
import { resumableStep, TOUR_STEPS, useProductTourState, type ProductTourRequest } from '../lib/productTour'
import { useAuth } from '../store/auth'
import '../components/productTour/catalog'
import { ASSISTANT_APP_ID, assistantEntryUnread, openAssistantEntry, useAssistantEntryTarget } from '../lib/assistantEntry'
import { useChatStore } from '../store/chatContext'
import { readPanelToggle } from '../lib/panelToggles'
import { useSidebarChatView } from '../lib/sidebarChatsBridge'
import { cn } from '@/lib/cn'
import { DropdownMenu, Menu, MenuItem as DropdownMenuItem, MenuSeparator } from './ui/Menu'
import { OpenableAppRows } from './chat/OpenAppMenuItems'
import { useRowContextMenu } from '../hooks/useRowContextMenu'
import { followLink } from '../lib/guguLinks'
import { Hint } from './ui/Tooltip'
import { useTranslation } from 'react-i18next'
import { useToast } from './toastContext'
import './Sidebar.css'
import '../i18n/registerVoiceNotesCatalog'
import { useVoiceNoteHandler } from './assistant/useVoiceNoteHandler'

interface SidebarProps {
  activeTab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  /** 设置弹窗开着:栏底那枚齿轮亮着(product spec「入口」)。 */
  settingsOpen?: boolean
  pendingContactsCount?: number
  // @@@sessionpage otty-state — 会话页 agent 里最急的那种「要人来处理」:有人等你(needs_user)是琥珀点,
  // 只有出错(error)是红点(gugu-dev#181),不进会话页也看得见。
  sessionAttention?: AgentAttention
}

// ─── Icons ────────────────────────────────────────────────────────────────────
// Solar 线框字形;选中只靠格子的底色(gugu-dev#181 原型:线框气泡、选中浅底),❌ 换成实心。Paths per design SSOT.
// @@@ui-ruler 手写 svg 的 width/height 是 DOM 属性,不是 style,CSS var() 在那个位置不会被解析
// (只有 CSS 属性会解析 var())。这些图标本就落在 --icon-rail(22px)上,保留字面量 22,不为了引用
// token 改成 style 覆盖 —— 那样才是新增一处几何。

function ChatIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.5" d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12c0 1.6.376 3.112 1.043 4.453c.178.356.237.763.134 1.148l-.595 2.226a1.3 1.3 0 0 0 1.591 1.592l2.226-.596a1.63 1.63 0 0 1 1.149.133A9.96 9.96 0 0 0 12 22Z"/>
    </svg>
  )
}

function ContactsIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="9" cy="6" r="4"/>
        <path className="gg-rail-back" strokeLinecap="round" d="M15 9a3 3 0 1 0 0-6"/>
        <ellipse cx="9" cy="17" rx="7" ry="4"/>
        <path className="gg-rail-back" strokeLinecap="round" d="M18 14c1.754.385 3 1.359 3 2.5c0 1.03-1.014 1.923-2.5 2.37"/>
      </g>
    </svg>
  )
}

// 「App」= App 市场:一格被拎出来、正要拼进去(同 VS Code 活动栏「扩展」入口;那页也是「已安装 + 市场」,#7046)。
// Solar 里搜不到这个字形(puzzle / plugin / extension / block 零命中;widget-add 说的是「添加」这个动作,
// 加号还正好压在更新红点底下),所以与上面几枚一样内联。形取自 lucide `blocks`(ISC),线宽改成 1.5 与 Solar 同族。
function AppsIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2" />
        <rect className="gg-rail-piece" x="14" y="2" width="8" height="8" rx="1" />
      </g>
    </svg>
  )
}

// ─── Rail button (`.ri` equivalent) ──────────────────────────────────────────

/** The rest of a button's props: a menu Trigger renders a RailItem and hands it its own (ref, handlers, data-popup-open). */
interface RailItemProps extends Omit<React.ComponentPropsWithRef<'button'>, 'title' | 'onClick' | 'onContextMenu' | 'className'> {
  icon: React.ReactNode
  active?: boolean
  onClick?: () => void
  title: string
  testId?: AutomationTestId
  badge?: number
  /** 点的颜色:默认红;`warn` = 琥珀(有人在等你,同列表里「需要你」那一色)。 */
  badgeTone?: 'warn'
  /** Which entry this is (`tasks` / `chats` / …): its own small move on hover hangs off this (Sidebar.css). */
  rail?: string
  /** An App that is running: a dot to the left of its icon, as the macOS dock marks one (#7050). */
  running?: boolean
  onContextMenu?: (event: React.MouseEvent) => void
  /** Its right-click menu is open: it stays lit like under the pointer, so the menu reads as this one's. */
  menuOpen?: boolean
  /** A different box than the 40px icon tile. */
  className?: string
}

function RailItem({
  icon,
  active = false,
  onClick,
  title,
  testId,
  badge = 0,
  badgeTone,
  rail,
  running = false,
  onContextMenu,
  menuOpen = false,
  className,
  ...button
}: RailItemProps) {
  // @@@4323 说明文字走产品自己的浮层。原生 title 在这条竖排图标栏上最难受:
  // 图标只有形状没有文字,而 title 要等操作系统那 ~1s、扫过一排时一个都不弹、触屏上永远不弹。
  return (
    <Hint label={title}>
      <button
        {...button}
        type="button"
        className={cn('gg-sidebar-item', className)}
        aria-label={title}
        aria-current={active ? 'page' : undefined}
        data-testid={testId}
        data-on={active || undefined}
        data-rail={rail}
        data-menu-open={menuOpen || undefined}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {icon}
        {badge > 0 && (
          <span className="gg-sidebar-badge" data-tone={badgeTone} aria-hidden="true" />
        )}
        {running && <i className="gg-sidebar-running" aria-hidden="true" />}
      </button>
    </Hint>
  )
}

// ─── Help & tour ──────────────────────────────────────────────────────────────
// 导览唯一的入口:从第 n 步继续(中途退出 / 跳过的,带一个点)、从头开始。真实短片就绪前不展示短片入口。
// 导览只有桌面端有。
function HelpOnRail() {
  const { t } = useTranslation('productTour')
  const { user } = useAuth()
  const tour = useProductTourState(user?.id ?? null)
  const resume = resumableStep(tour.data)
  const [open, setOpen] = useState(false)
  const request = (detail: ProductTourRequest) => {
    window.dispatchEvent(new CustomEvent(UI_EVENTS.reopenProductTour, { detail }))
  }
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger render={<RailItem icon={<HelpCircle size={22} />} active={open} menuOpen={open} title={t('help.label')} rail="help" badge={resume ? 1 : 0} />} />
      <DropdownMenu.Content className="min-w-[200px]" aria-label={t('help.label')}>
        {resume && (
          <DropdownMenuItem onClick={() => request({ mode: 'resume', step: resume })}>
            {t('help.resume', { current: TOUR_STEPS.indexOf(resume) + 1, total: TOUR_STEPS.length })}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => request({ mode: 'restart' })}>{t('help.restart')}</DropdownMenuItem>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}

// ─── Apps on the rail ─────────────────────────────────────────────────────────
// 「App」 and the dock are places on the one session page (its `apps` / `app` views, drawn without the task list): the rail
// shows the session page there. Desktop only — Apps run in the desktop app.

/** Where the session page is, as the rail lights it: its App page, one App from the dock, the library, or the tasks. */
function sessionPagePlace(): 'tasks' | 'apps' | 'library' | { app: string } {
  const view = appState.navigation.currentViewId
  if (view === 'apps') return 'apps'
  if (view === 'library') return 'library'
  if (view === 'app') return { app: appState.navigation.viewParamsStore.app?.appId ?? '' }
  return 'tasks'
}

const DockItem = observer(function DockItem({ app, active, onOpen, onOpenInWindow, onUnpin, onQuit }: { app: RailApp; active: boolean; onOpen: () => void; onOpenInWindow: () => void; onUnpin: () => void; onQuit: () => void }) {
  const { t } = useTranslation('main')
  // Dragged to reorder; a click (the pointer moved less than 4px) still opens it. A right click never drags (dnd-kit's
  // pointer sensor takes the primary button only).
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: app.extensionId })
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  const running = appIsRunning(app.extensionId)
  return (
    <>
      <div
        ref={setNodeRef}
        data-dock-app={app.extensionId}
        data-dragging={isDragging || undefined}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        {...listeners}
      >
        {installedExtensionsStore.manifestFor(app.extensionId)?.contributes.unreadSource
          ? <AppConversationUnread extensionId={app.extensionId}>{unread => <RailItem
              icon={<RailAppIcon app={app} />} active={active} onClick={onOpen} title={app.name}
              badge={unread === true || extensionSurfaceStore.badgedAnywhere(app.kind) ? 1 : 0}
              running={running} onContextMenu={onContextMenu} menuOpen={menuPos !== null}
            />}</AppConversationUnread>
          : <RailItem icon={<RailAppIcon app={app} />} active={active} onClick={onOpen} title={app.name}
              badge={extensionSurfaceStore.badgedAnywhere(app.kind) ? 1 : 0}
              running={running} onContextMenu={onContextMenu} menuOpen={menuPos !== null} />}
      </div>
      {/* Outside the sortable box: the menu is portalled, but React still bubbles its presses to the box's drag listeners. */}
      {menuPos && (
        // 照 macOS 程序坞:没开着有「打开」(开着的那一下点图标就是去它那里),开着的最下面多一个「退出」(#7050)。
        <Menu x={menuPos.x} y={menuPos.y} onClose={closeMenu}>
          {!running && (
            <DropdownMenuItem onClick={() => { onOpen(); closeMenu() }}>{t('shell.appOpen')}</DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => { onOpenInWindow(); closeMenu() }}>{t('shell.appOpenInWindow')}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { void followLink({ kind: 'app-detail', extensionId: app.extensionId }); closeMenu() }} data-testid="rail-app-settings">{t('shell.appSettings')}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { onUnpin(); closeMenu() }}>{t('shell.appUnpin')}</DropdownMenuItem>
          {running && <MenuSeparator />}
          {running && (
            <DropdownMenuItem onClick={() => { onQuit(); closeMenu() }}>{t('shell.appQuit')}</DropdownMenuItem>
          )}
        </Menu>
      )}
    </>
  )
})

/**
 * The assistant App on the rail (owner 11-06: the assistant is an App, its entry is with the Apps; 11-12: 「放在 App 那块，
 * 哪怕是内置的也要放到下面」): the first App of the group, its own icon, the siblings' look. A click goes where the entry
 * decision says (lib/assistantEntry.ts); its dot is the assistant chat's unread (#1930, read from the chat itself) or a
 * voice note being recorded in it. There only while the App is where the assistant lives — installed, on, trusted
 * (`target.kind === 'app'`); otherwise nothing of it is on the rail and its chat is a chat in the message list.
 */
const AssistantAppItem = observer(function AssistantAppItem({ app, chatId, active, onOpen }: { app: RailApp; chatId: string | null; active: boolean; onOpen: () => void }) {
  const { chats } = useChatStore('chats')
  const unread = !!chatId && assistantEntryUnread(chats, chatId) === true
  const { t: tVoice } = useTranslation('voiceNotes')
  const { recording } = useVoiceNoteHandler()
  return (
    <RailItem icon={<RailAppIcon app={app} />} active={active} onClick={onOpen} title={recording ? tVoice('bar.recording') : app.name}
      testId={AUTOMATION_TEST_IDS.sidebarAssistantNav} rail="assistant" running={appIsRunning(app.extensionId)}
      badge={recording || unread || extensionSurfaceStore.badgedAnywhere(app.kind) ? 1 : 0} />
  )
})

const AppsOnRail = observer(function AppsOnRail({ sessionsShown, showSessions }: { sessionsShown: boolean; showSessions: () => void }) {
  const { t } = useTranslation('main')
  const { toast } = useToast()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  const place = sessionsShown ? sessionPagePlace() : null
  // The assistant App heads the group (AssistantAppItem), so it is not a second icon among the pinned ones.
  const target = useAssistantEntryTarget()
  const assistantApp = target.kind === 'app' ? installedExtensionsStore.openableApps.find((app) => app.extensionId === ASSISTANT_APP_ID) ?? null : null
  const apps = installedExtensionsStore.dockedApps.filter((app) => !(assistantApp && app.extensionId === ASSISTANT_APP_ID))
  // A right click on 「App」 lists every App it can open, pinned or not: a click opens it, as its icon on the rail would.
  const openable = installedExtensionsStore.openableApps
  const open = (appId?: string) => {
    showSessions()
    if (appId) openApp(appId)
    else appState.navigation.navigate('apps')
  }
  const dockFailed = (error: unknown) => { rendererLogger('actions/Sidebar').error({ error: error }, 'action failed'); toast(t('shell.appDockFailed'), 'error', messageForUser(error)) }
  const reorder = ({ active, over }: DragEndEvent) => {
    const dock = installedExtensionsStore.dock
    if (!over || active.id === over.id) return
    void setDock(arrayMove(dock, dock.indexOf(String(active.id)), dock.indexOf(String(over.id)))).catch(dockFailed)
  }
  return (
    <>
      <RailItem
        icon={<AppsIcon />}
        active={place === 'apps'}
        onClick={() => open()}
        title={t('shell.apps')}
        testId={AUTOMATION_TEST_IDS.sidebarAppsNav}
        badge={installedExtensionsStore.updateCount}
        rail="apps"
        onContextMenu={openable.length > 0 ? onContextMenu : undefined}
        menuOpen={menuPos !== null}
      />
      {menuPos && openable.length > 0 && (
        <Menu x={menuPos.x} y={menuPos.y} minWidth={180} onClose={closeMenu} ariaLabel={t('shell.apps')}>
          <OpenableAppRows apps={openable} onOpen={(appId) => { open(appId); closeMenu() }} />
        </Menu>
      )}
      {(assistantApp || apps.length > 0) && <i className="gg-sidebar-rail-sep" aria-hidden="true" />}
      {(assistantApp || apps.length > 0) && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
          <SortableContext items={apps.map((app) => app.extensionId)} strategy={verticalListSortingStrategy}>
            <div className="gg-sidebar-dock" data-testid={AUTOMATION_TEST_IDS.sidebarDock}>
              {assistantApp && target.kind === 'app' ? (
                <AssistantAppItem app={assistantApp} chatId={target.chatId} active={typeof place === 'object' && place?.app === ASSISTANT_APP_ID}
                  onOpen={() => { showSessions(); openAssistantEntry() }} />
              ) : null}
              {apps.map((app) => (
                <DockItem
                  key={app.extensionId}
                  app={app}
                  active={typeof place === 'object' && place?.app === app.extensionId}
                  onOpen={() => open(app.extensionId)}
                  onOpenInWindow={() => openAppInWindow(app.extensionId)}
                  onUnpin={() => void unpinFromDock(app.extensionId).catch(dockFailed)}
                  onQuit={() => void quitApp(app.extensionId).catch((error) => { rendererLogger('actions/Sidebar').error({ error: error }, 'action failed'); return toast(t('shell.appQuitFailed'), 'error', messageForUser(error)); })}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </>
  )
})

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export const Sidebar = observer(function Sidebar({ activeTab, onTabChange, settingsOpen = false, pendingContactsCount = 0, sessionAttention = null }: SidebarProps) {
  const { t } = useTranslation('main')
  const messagesActive = activeTab === 'chats' || (activeTab === 'tasks' && sessionPagePlace() === 'tasks')
  // #2548 the sidebar as one list: 「消息」 is that list, so clicking it again while it is the one shown folds / unfolds it
  // (the same toggle as the list's own collapse button and its shortcut, lib/panelToggles).
  const oneList = useSidebarChatView().oneList === true
  // 手机版 — 移动端交接后端(#1534)就绪后再提供入口

  return (
    <aside className="gg-sidebar-rail" aria-label={t('shell.mainNavigation')}>
      <div className="gg-sidebar-primary">
        {/* @@@task-web-host — 任务入口在 web 与桌面两个目标下都渲染:网页版由无头宿主供后端。 */}
        <nav className="gg-sidebar-nav" aria-label={t('shell.features')}>
          {/* gugu-dev#181:「项目」「对话」两格合成一格「消息」—— 项目就是群,没有项目的会话就是和 agent 私聊,
              两边都在会话页侧栏里(顶上「项目 | 对话」两枚页签)。咕咕是 App,在 App 那一组里(AssistantAppItem)。
              对话还没做成会话页的块之前,打开一条对话仍落在聊天页上,那里这一格照样亮着。 */}
          <RailItem
            icon={<ChatIcon />}
            active={messagesActive}
            onClick={() => {
              if (oneList && activeTab === 'tasks' && sessionPagePlace() === 'tasks') {
                const sidebar = readPanelToggle('list:sessions')
                if (!sidebar) throw new Error('the task page is shown but has not registered its sidebar toggle')
                sidebar.toggle()
                return
              }
              onTabChange('tasks')
              if (sessionPagePlace() === 'tasks') return
              returnToScreen()
            }}
            title={t('shell.messages')}
            testId={AUTOMATION_TEST_IDS.sidebarMessagesNav}
            rail="chats"
            badge={sessionAttention ? 1 : 0}
            badgeTone={sessionAttention === 'needs_user' ? 'warn' : undefined}
          />
          <RailItem
            icon={<ContactsIcon />}
            active={activeTab === 'contacts'}
            onClick={() => onTabChange('contacts')}
            title={t('shell.contacts')}
            testId={AUTOMATION_TEST_IDS.sidebarContactsNav}
            rail="contacts"
            badge={pendingContactsCount}
          />
          {platform.capabilities.agentRuntime && (
            <RailItem
              icon={<Library size={22} />}
              active={activeTab === 'tasks' && sessionPagePlace() === 'library'}
              onClick={() => {
                onTabChange('tasks')
                appState.navigation.navigate('library')
              }}
              title={t('shell.library')}
              testId={AUTOMATION_TEST_IDS.sidebarLibraryNav}
              rail="library"
            />
          )}
          {platform.capabilities.agentRuntime && (
            <AppsOnRail sessionsShown={activeTab === 'tasks'} showSessions={() => onTabChange('tasks')} />
          )}
        </nav>
      </div>

      <div className="gg-sidebar-spacer" />

      <div className="gg-sidebar-bottom">
        <UpdateBanner placement="rail" />
        {platform.kind === 'electron' && <HelpOnRail />}
        {/* 设置在栏底,一点就开(product spec「入口」;owner 10-15 推翻 #7046 里「设置收进头像菜单」那一半)。
            摆法照 VS Code 活动栏栏底的「管理」齿轮;owner 10-16 移除了本人账户按钮。⌘,、应用菜单「设置…」、
            命令面板开的是同一个弹窗,弹窗开着(不管从哪开的)这枚就亮着。 */}
        <RailItem
          icon={<Settings size={22} />}
          active={settingsOpen}
          onClick={() => onTabChange('settings')}
          title={t('shell.settings')}
          testId={AUTOMATION_TEST_IDS.sidebarSettingsNav}
          rail="settings"
        />
      </div>

      {/* 手机版 icon 已移除(owner 决定):移动端交接后端(#1534)未建,与其留一个诚实禁用但仍被误认作
          「死按钮」的占位,不如直接不渲染;#1534 落地后再作为真功能加回。 */}

    </aside>
  )
})

