import type { ComponentProps, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutGrid, X } from '@/lib/icons'
import { useInstalledApps, type InstalledApps, type RailApp } from '../../session/renderer/features/extensions/installed-extensions'
import { ReadingSlot } from '../ui/ReadingSlot'
import { RailAppIcon } from '../RailAppIcon'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { Sheet } from '../ui/Sheet'
import { menuSurfaceClassName } from '../ui/Menu'
import { HERE_HOST } from '../appSlot/hereHost'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'

/** The one Apps button of a chat's or a task's header (`size`/`labeled` follow the header's density). */
export function AppsButton({ labeled, ...props }: Omit<ComponentProps<typeof Button>, 'children'> & { labeled?: boolean }) {
  const { t } = useTranslation('messaging')
  return <Button variant="ghost" data-testid={AUTOMATION_TEST_IDS.chatHeaderAppsButton} aria-label={t('header.apps')} title={t('header.apps')} {...props}><LayoutGrid />{labeled && t('header.apps')}</Button>
}

/** The Apps a chat or a task can open, one picker for both; where a picked App opens is the caller's (`onOpen`): beside the chat, or a tab of the task. */
export function ChatAppsPicker({ chatId, onOpen, mobile, anchor, onClose }: {
  chatId: string | null
  onOpen: (app: RailApp) => void
  mobile?: boolean
  anchor: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const installed = useInstalledApps(HERE_HOST)
  const body = (
    <div data-testid={AUTOMATION_TEST_IDS.chatAppsPicker} className="p-2">
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <h2 className="flex-1 text-[length:var(--font-body)] font-medium">{t('header.apps')}</h2>
        <IconButton size="sm" aria-label={t('common.close')} onClick={onClose}><X /></IconButton>
      </div>
      {!HERE_HOST ? <p className="px-2 py-3 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('header.noApps')}</p>
        : <ReadingSlot reading={installed} placeholder="m-2 w-32">{(value) => <ChatAppRows chatId={chatId} installed={value} onOpen={onOpen} onClose={onClose} />}</ReadingSlot>}
    </div>
  )
  return mobile ? <Sheet onClose={onClose} finalFocus={anchor} mobileFitContent ariaLabel={t('header.apps')}>{body}</Sheet> : (
    <Popover.Portal><Popover.Positioner anchor={anchor} side="bottom" align="end" sideOffset={4} collisionPadding={8}>
      <Popover.Popup aria-label={t('header.apps')} finalFocus={anchor} className={`${menuSurfaceClassName} max-h-[70vh] w-max min-w-40 max-w-[min(calc(var(--spacing)*80),calc(100vw-var(--spacing)*4))] overflow-y-auto`}>{body}</Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  )
}

function ChatAppRows({ chatId, installed, onOpen, onClose }: { chatId: string | null; installed: InstalledApps; onOpen: (app: RailApp) => void; onClose: () => void }) {
  const { t } = useTranslation('messaging')
  // A task has no chat folder (`chatId` null): only Apps with a page of their own.
  const apps = installed.appsIn(chatId ? 'chat' : 'page')
  return (
    <>
      {apps.map((app) => (
          <div key={app.extensionId} data-app-id={app.extensionId} className="flex items-center gap-1">
            <Button variant="ghost" className="min-w-0 flex-1 justify-start" data-testid="chat-apps-open" data-pane-opener="" onClick={() => { onOpen(app); onClose() }}>
              <RailAppIcon app={app} className="gg-sidebar-launch-icon" /><span className="truncate">{app.name}</span>
            </Button>
          </div>
      ))}
      {apps.length === 0 && <p className="px-2 py-3 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('header.noApps')}</p>}
    </>
  )
}
