import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { observer } from 'mobx-react-lite'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import { LOCAL_HOST, marketUpdates, updateCountOf, useInstalledApps, type InstalledApps, type RailApp } from '../../session/renderer/features/extensions/installed-extensions'
import { useReplica } from '../../lib/replica'
import { AppConversationUnread } from '../extensionBundle/AppConversationUnread'
import { extensionSurfaceStore } from '../../session/renderer/features/extensions/extension-surface-store'
import { appIsRunning, openApp, openAppInWindow, quitApp, unpinFromDock } from '../../session/renderer/features/extensions/app-dock'
import { appState } from '../../session/renderer/lib/stores/app-state'
import { RailAppIcon } from '../RailAppIcon'
import { UpdateBanner } from '../UpdateBanner'
import { AUTOMATION_TEST_IDS, type AutomationTestId } from '../../lib/automationDom'
import { ChevronDown, ChevronRight, Settings, UserRound } from '@/lib/icons'
import { ASSISTANT_APP_ID, assistantEntryUnread, openAssistantEntry, useAssistantEntryTarget } from '../../lib/assistantEntry'
import { useChatStore } from '../../store/chatContext'
import { cn } from '@/lib/cn'
import { Menu, MenuItem as DropdownMenuItem, MenuSeparator } from '../ui/Menu'
import { Popover } from '../ui/Popover'
import { Button } from '../ui/Button'
import { Unknown } from '../ui/Unknown'
import { Avatar } from '../Avatar'
import { useRowContextMenu } from '../../hooks/useRowContextMenu'
import { followLink } from '../../lib/guguLinks'
import { Hint } from '../ui/Tooltip'
import { useTranslation } from 'react-i18next'
import { useToast } from '../toastContext'
import { useAuth } from '../../store/auth'
import { formatCredits, useSpendingPower } from '../../lib/billing'
import { UI_EVENTS } from '../../lib/uiEvents'
import { readShellSlots } from '../../lib/shellSlots'
import { ME_SLOT_PREFIX } from './MeSlot'
import '../Sidebar.css'
import './MeMenu.css'
import '../../i18n/registerVoiceNotesCatalog'
import { useVoiceNoteHandler } from '../assistant/useVoiceNoteHandler'

// ─── Icons ────────────────────────────────────────────────────────────────────

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

// ─── An icon tile (the old rail's `.ri`) ─────────────────────────────────────

/** The rest of a button's props: a menu Trigger renders a RailItem and hands it its own (ref, handlers, data-popup-open). */
interface RailItemProps extends Omit<React.ComponentPropsWithRef<'button'>, 'title' | 'onClick' | 'onContextMenu' | 'className'> {
  icon: React.ReactNode
  active?: boolean
  onClick?: () => void
  title: string
  testId?: AutomationTestId
  badge?: number | null
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
        {badge != null && badge > 0 && (
          <span className="gg-sidebar-badge" data-tone={badgeTone} aria-hidden="true" />
        )}
        {running && <i className="gg-sidebar-running" aria-hidden="true" />}
      </button>
    </Hint>
  )
}

// ─── The Apps in my menu ──────────────────────────────────────────────────────
// The dock's Apps are a row of icons in my menu (界面减法 #51, yangchichi msg:9fa1296d). Desktop only — Apps run in the
// desktop app.

/** Where the session page is: an App's own place lights its icon. */
function sessionPagePlace(): 'tasks' | 'apps' | { app: string } {
  const view = appState.navigation.currentViewId
  if (view === 'apps') return 'apps'
  if (view === 'app') return { app: appState.navigation.viewParamsStore.app?.appId ?? '' }
  return 'tasks'
}

const DockItem = observer(function DockItem({ apps, app, active, onOpen, onOpenInWindow, onUnpin, onQuit }: { apps: InstalledApps; app: RailApp; active: boolean; onOpen: () => void; onOpenInWindow: () => void; onUnpin: () => void; onQuit: () => void }) {
  const { t } = useTranslation('main')
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  const running = appIsRunning(apps, app.extensionId)
  return (
    <>
      <div data-dock-app={app.extensionId}>
        {apps.manifestFor(app.extensionId)?.contributes.unreadSource
          ? <AppConversationUnread extensionId={app.extensionId}>{unread => <RailItem
              icon={<RailAppIcon app={app} />} active={active} onClick={onOpen} title={app.name}
              badge={unread === true || extensionSurfaceStore.badgedAnywhere(app.kind) ? 1 : 0}
              running={running} onContextMenu={onContextMenu} menuOpen={menuPos !== null}
            />}</AppConversationUnread>
          : <RailItem icon={<RailAppIcon app={app} />} active={active} onClick={onOpen} title={app.name}
              badge={extensionSurfaceStore.badgedAnywhere(app.kind) ? 1 : 0}
              running={running} onContextMenu={onContextMenu} menuOpen={menuPos !== null} />}
      </div>
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
 * The assistant App among the Apps (owner 11-06: the assistant is an App, its entry is with the Apps; 11-12: 「放在 App 那块，
 * 哪怕是内置的也要放到下面」): the first App of the group, its own icon, the siblings' look. A click goes where the entry
 * decision says (lib/assistantEntry.ts); its dot is the assistant chat's unread (#1930, read from the chat itself) or a
 * voice note being recorded in it. There only while the App is where the assistant lives — installed, on, trusted
 * (`target.kind === 'app'`); otherwise nothing of it is in the row and its chat is a chat in the message list.
 */
const AssistantAppItem = observer(function AssistantAppItem({ apps, app, chatId, active, onOpen }: { apps: InstalledApps; app: RailApp; chatId: string | null; active: boolean; onOpen: () => void }) {
  const { chats } = useChatStore('chats')
  const unread = !!chatId && assistantEntryUnread(chats, chatId) === true
  const { t: tVoice } = useTranslation('voiceNotes')
  const { recording } = useVoiceNoteHandler()
  return (
    <RailItem icon={<RailAppIcon app={app} />} active={active} onClick={onOpen} title={recording ? tVoice('bar.recording') : app.name}
      testId={AUTOMATION_TEST_IDS.sidebarAssistantNav} rail="assistant" running={appIsRunning(apps, app.extensionId)}
      badge={recording || unread || extensionSurfaceStore.badgedAnywhere(app.kind) ? 1 : 0} />
  )
})


// ─── My menu ──────────────────────────────────────────────────────────────────

interface MeMenuProps {
  onTabChange: (tab: SidebarTab) => void
  pendingContactsCount: number
}

/** The dock's Apps as a row of icons (the assistant first), under a line that folds them away. */
const MeApps = observer(function MeApps({ showSessions, close }: { showSessions: () => void; close: () => void }) {
  const { t } = useTranslation('main')
  const { toast } = useToast()
  const [folded, setFolded] = useState(false)
  const place = sessionPagePlace()
  const target = useAssistantEntryTarget()
  const installed = useInstalledApps(LOCAL_HOST)
  const apps = installed.state === 'value' ? installed.value : null
  const assistantApp = apps && target.kind === 'app' ? apps.appsIn('page').find((app) => app.extensionId === ASSISTANT_APP_ID) ?? null : null
  const docked = apps ? apps.dockedApps.filter((app) => !(assistantApp && app.extensionId === ASSISTANT_APP_ID)) : []
  if (!apps || (!assistantApp && docked.length === 0)) return null
  const open = (appId: string) => { showSessions(); openApp(appId); close() }
  const dockFailed = (error: unknown) => { rendererLogger('actions/MeMenu').error({ error }, 'action failed'); toast(t('shell.appDockFailed'), 'error', messageForUser(error)) }
  return (
    <div data-testid={AUTOMATION_TEST_IDS.sidebarDock}>
      <button type="button" className="gg-me-row" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
        <span className="gg-me-row-label">{t('shell.pinnedApps')}</span>
        <span className="gg-me-row-key">{folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
      </button>
      {!folded && (
        <div className="gg-me-apps">
          {assistantApp && target.kind === 'app' && (
            <AssistantAppItem apps={apps} app={assistantApp} chatId={target.chatId} active={typeof place === 'object' && place.app === ASSISTANT_APP_ID}
              onOpen={() => { showSessions(); openAssistantEntry(); close() }} />
          )}
          {docked.map((app) => (
            <DockItem key={app.extensionId} apps={apps} app={app}
              active={typeof place === 'object' && place.app === app.extensionId}
              onOpen={() => open(app.extensionId)}
              onOpenInWindow={() => openAppInWindow(app.extensionId)}
              onUnpin={() => void unpinFromDock(app.extensionId).catch(dockFailed)}
              onQuit={() => void quitApp(app.extensionId).catch((error) => { rendererLogger('actions/MeMenu').error({ error }, 'action failed'); return toast(t('shell.appQuitFailed'), 'error', messageForUser(error)) })}
            />
          ))}
        </div>
      )}
    </div>
  )
})

function MeRow({ icon, label, keyHint, badge, onClick, testId }: { icon: ReactNode; label: string; keyHint?: ReactNode; badge?: number | null; onClick: () => void; testId?: AutomationTestId }) {
  return (
    <button type="button" className="gg-me-row" onClick={onClick} data-testid={testId}>
      <span className="gg-me-row-icon">{icon}</span>
      <span className="gg-me-row-label">{label}</span>
      {badge != null && badge > 0 && <span className="gg-sidebar-badge gg-me-row-badge" aria-hidden="true" />}
      {keyHint && <span className="gg-me-row-key">{keyHint}</span>}
    </button>
  )
}

/**
 * 界面减法 #51: my own avatar at the foot of the sidebar (with my name when it is open) opens my menu — who I am, my
 * credits and the full usage, 联系人, 市场, the dock's Apps, 设置 and, when there is one, the update. It takes every place
 * the far-left rail had; a dot on my avatar says one of them wants me (a contact request, an App update).
 */
const MeButton = observer(function MeButton({ rail, onTabChange, pendingContactsCount }: MeMenuProps & { rail: boolean }) {
  const { t } = useTranslation('main')
  const { user } = useAuth()
  const spending = useSpendingPower(user)
  const [open, setOpen] = useState(false)
  const updates = useReplica(marketUpdates, [LOCAL_HOST])
  const installed = useInstalledApps(LOCAL_HOST)
  const apps = installed.state === 'value' ? installed.value : null
  const updateCount = apps && updates.state === 'value' && updates.value.summary ? updateCountOf(updates.value.summary, apps) : null
  const name = user?.nickname ?? ''
  const close = () => setOpen(false)
  const showSessions = () => onTabChange('tasks')
  const face = (size: number) => <Avatar name={name} avatarUrl={user?.avatarUrl} seed={user?.id} size={size} />
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Hint label={t('shell.accountMenu')} side={rail ? 'right' : 'top'}>
        <Popover.Trigger type="button" className={cn('gg-me-trigger', rail && 'gg-me-trigger-rail')} aria-label={t('shell.accountMenu')} data-on={open || undefined} data-testid="me-menu-trigger">
          <span className="relative flex">
            {face(rail ? 36 : 34)}
            {((pendingContactsCount > 0) || (updateCount ?? 0) > 0) && <span className="gg-sidebar-badge gg-me-trigger-badge" aria-hidden="true" />}
          </span>
          {!rail && <span className="gg-me-trigger-name">{name}</span>}
        </Popover.Trigger>
      </Hint>
      <Popover.Portal><Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={8}>
        <Popover.Popup className="gg-me-pop" data-testid="me-menu">
          <div className="gg-me-blk gg-me-who">{face(52)}<b>{name}</b></div>
          <div className="gg-me-blk">
            <div className="gg-me-credits-label">{t('usagePopover.credits')}</div>
            <div className="gg-me-credits">
              {!user ? t('usagePopover.signedOut')
                : spending.state === 'unknown' ? <Unknown className="h-6 w-24" />
                  : spending.balance === null ? <span role="status">{t('usagePopover.readFailed')}</span>
                    : formatCredits(spending.balance)}
            </div>
            <Button variant="secondary" className="mt-2 w-full" data-testid="sidebar-usage"
              onClick={() => { close(); window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'usage' } })) }}>
              {t('usagePopover.fullUsage')}
            </Button>
          </div>
          <div className="gg-me-blk">
            <MeRow icon={<UserRound size={19} />} label={t('shell.contactsMenu')} keyHint="⌘2" badge={pendingContactsCount}
              testId={AUTOMATION_TEST_IDS.sidebarContactsNav} onClick={() => { close(); onTabChange('contacts') }} />
            <MeRow icon={<AppsIcon />} label={t('shell.apps')} keyHint={<ChevronRight size={14} />} badge={updateCount}
              testId={AUTOMATION_TEST_IDS.sidebarAppsNav} onClick={() => { close(); showSessions(); appState.navigation.navigate('apps') }} />
            <MeApps showSessions={showSessions} close={close} />
            <div className="gg-me-sep" />
            <MeRow icon={<Settings size={19} />} label={t('shell.settings')} keyHint="⌘,"
              testId={AUTOMATION_TEST_IDS.sidebarSettingsNav} onClick={() => { close(); onTabChange('settings') }} />
            <UpdateBanner placement="rail" />
          </div>
        </Popover.Popup>
      </Popover.Positioner></Popover.Portal>
    </Popover.Root>
  )
})

const NO_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()

/** Draws my avatar and its menu into every slot the session page's sidebar leaves for it (MeSlot), in the shell's contexts. */
export function MeHost(props: MeMenuProps) {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(listener => slots?.subscribeSlots(listener) ?? (() => undefined), () => slots?.getSlots() ?? NO_SLOTS)
  return <>{[...entries].map(([key, element]) => key.startsWith(ME_SLOT_PREFIX)
    ? createPortal(<MeButton {...props} rail={slots?.getSlotLabel?.(key) === 'rail'} />, element, key)
    : null)}</>
}
