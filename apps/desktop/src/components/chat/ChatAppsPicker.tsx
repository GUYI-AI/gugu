import type { ComponentProps, RefObject } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { LayoutGrid, X } from '@/lib/icons'
import { installedExtensionsStore, type RailApp } from '../../session/renderer/features/extensions/installed-extensions-store'
import { RailAppIcon } from '../RailAppIcon'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { Sheet } from '../ui/Sheet'
import { menuSurfaceClassName } from '../ui/Menu'
import { appsHere } from '../appSlot/appsHere'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { replica, useReplicas } from '../../lib/replica'
import { Unknown } from '../ui/Unknown'

/**
 * The Apps this chat can open: those with a page of their own, and those with a file in this chat's folder they open —
 * an agent's group game is the second kind and opens on its file, as its card's 「Open」 (5-minute game ①). An App that only
 * opens files and has none here would open nothing, so it is not listed.
 */
// Whether this chat's folder has a file the App opens: one reading per chat and App.
const chatAppHasFiles = replica({
  name: 'chatAppHasFiles',
  scope: 'account',
  read: async (_owner: string, chatId: string, extensionId: string) => {
    const files = await appsHere?.groupFilesOpenedBy({ chatId, extensionId })
    return !!files?.success && (files.data?.length ?? 0) > 0
  },
})

/**
 * The Apps to list, and whether some file-only App is not answered yet (its row is a placeholder, ❌「无应用」). A task has no
 * chat folder (`chatId` null): only Apps with a page of their own.
 */
function useChatApps(chatId: string | null) {
  const all = installedExtensionsStore.chatOpenableApps
  const fileOnly = chatId ? all.filter((app) => !installedExtensionsStore.mainTabOf(app.extensionId)) : []
  const readings = useReplicas(chatAppHasFiles, fileOnly.map((app) => [chatId!, app.extensionId] as [string, string]))
  const hasFiles = new Map(fileOnly.map((app, index) => [app.extensionId, readings[index]!]))
  const apps = all.filter((app) => {
    if (installedExtensionsStore.mainTabOf(app.extensionId)) return true
    const reading = hasFiles.get(app.extensionId)
    return reading?.state === 'value' && reading.value
  })
  return { apps, pending: readings.some((reading) => reading.state === 'unknown') }
}

/** The one Apps button of a chat's or a task's header (`size`/`labeled` follow the header's density). */
export function AppsButton({ labeled, ...props }: Omit<ComponentProps<typeof Button>, 'children'> & { labeled?: boolean }) {
  const { t } = useTranslation('messaging')
  return <Button variant="ghost" data-testid={AUTOMATION_TEST_IDS.chatHeaderAppsButton} aria-label={t('header.apps')} title={t('header.apps')} {...props}><LayoutGrid />{labeled && t('header.apps')}</Button>
}

/** The Apps a chat or a task can open, one picker for both; where a picked App opens is the caller's (`onOpen`): beside the chat, or a tab of the task. */
export const ChatAppsPicker = observer(function ChatAppsPicker({ chatId, onOpen, mobile, anchor, onClose }: {
  chatId: string | null
  onOpen: (app: RailApp) => void
  mobile?: boolean
  anchor: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const { apps, pending } = useChatApps(chatId)
  const body = (
    <div data-testid={AUTOMATION_TEST_IDS.chatAppsPicker} className="p-2">
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <h2 className="flex-1 text-[length:var(--font-body)] font-medium">{t('header.apps')}</h2>
        <IconButton size="sm" aria-label={t('common.close')} onClick={onClose}><X /></IconButton>
      </div>
      {apps.map((app) => (
          <div key={app.extensionId} data-app-id={app.extensionId} className="flex items-center gap-1">
            <Button variant="ghost" className="min-w-0 flex-1 justify-start" data-testid="chat-apps-open" data-pane-opener="" onClick={() => { onOpen(app); onClose() }}>
              <RailAppIcon app={app} className="gg-sidebar-launch-icon" /><span className="truncate">{app.name}</span>
            </Button>
          </div>
      ))}
      {pending ? <div className="px-2 py-2"><Unknown className="w-32" /></div>
        : apps.length === 0 && <p className="px-2 py-3 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t(installedExtensionsStore.isLoaded ? 'header.noApps' : 'common.loading')}</p>}
    </div>
  )
  return mobile ? <Sheet onClose={onClose} finalFocus={anchor} mobileFitContent ariaLabel={t('header.apps')}>{body}</Sheet> : (
    <Popover.Portal><Popover.Positioner anchor={anchor} side="bottom" align="end" sideOffset={4} collisionPadding={8}>
      <Popover.Popup aria-label={t('header.apps')} finalFocus={anchor} className={`${menuSurfaceClassName} max-h-[70vh] w-max min-w-40 max-w-[min(calc(var(--spacing)*80),calc(100vw-var(--spacing)*4))] overflow-y-auto`}>{body}</Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  )
})
