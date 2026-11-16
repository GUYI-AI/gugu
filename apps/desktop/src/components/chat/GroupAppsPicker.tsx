import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from '@/lib/icons'
import { installedExtensions, useInstalledApps, type InstalledApps } from '../../session/renderer/features/extensions/installed-extensions'
import { RefreshFailed } from '../ui/RefreshFailed'
import { RailAppIcon } from '../RailAppIcon'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { Sheet } from '../ui/Sheet'
import { menuSurfaceClassName } from '../ui/Menu'
import { openApp } from '../appSlot/useOpenApp'
import { appsHere } from '../appSlot/appsHere'
import { HERE_HOST } from '../appSlot/hereHost'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { replica, useReplicas } from '../../lib/replica'
import { Unknown } from '../ui/Unknown'

/**
 * The Apps this group can open: those with a page of their own, and those with a file in this group's folder they open —
 * an agent's group game is the second kind and opens on its file, as its card's 「Open」 (5-minute game ①). An App that only
 * opens files and has none here would open nothing, so it is not listed.
 */
// Whether this group's folder has a file the App opens: one reading per group and App.
const groupAppHasFiles = replica({
  name: 'groupAppHasFiles',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner: string, chatId: string, extensionId: string) => {
    const files = await appsHere?.groupFilesOpenedBy({ chatId, extensionId })
    return !!files?.success && (files.data?.length ?? 0) > 0
  },
})

/** The Apps to list, and whether some file-only App is not answered yet (its row is a placeholder, ❌「无群应用」). */
function useGroupApps(chatId: string, installed: InstalledApps) {
  const all = installed.chatOpenableApps
  const fileOnly = all.filter((app) => !installed.mainTabOf(app.extensionId))
  const readings = useReplicas(groupAppHasFiles, fileOnly.map((app) => [chatId, app.extensionId] as [string, string]))
  const hasFiles = new Map(fileOnly.map((app, index) => [app.extensionId, readings[index]!]))
  const apps = all.filter((app) => {
    if (installed.mainTabOf(app.extensionId)) return true
    const reading = hasFiles.get(app.extensionId)
    return reading?.state === 'value' && reading.value
  })
  return { apps, pending: readings.some((reading) => reading.state === 'unknown') }
}

export function GroupAppsPicker({ chatId, mobile, anchor, onClose }: {
  chatId: string
  mobile?: boolean
  anchor: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const installed = useInstalledApps(HERE_HOST)
  const body = (
    <div data-testid={AUTOMATION_TEST_IDS.groupAppsPicker} className="p-2">
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <h2 className="flex-1 text-[length:var(--font-body)] font-medium">{t('header.groupApps')}</h2>
        <IconButton size="sm" aria-label={t('common.close')} onClick={onClose}><X /></IconButton>
      </div>
      {!HERE_HOST ? <p className="px-2 py-3 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('header.noGroupApps')}</p>
        : installed.state === 'value' ? <GroupAppRows chatId={chatId} installed={installed.value} onClose={onClose} />
        : installed.state === 'error' ? <div className="px-2 py-2"><RefreshFailed error={installed.error} onRetry={() => { if (HERE_HOST) void installedExtensions.refresh(HERE_HOST) }} /></div>
        : <div className="px-2 py-2"><Unknown className="w-32" /></div>}
    </div>
  )
  return mobile ? <Sheet onClose={onClose} finalFocus={anchor} mobileFitContent ariaLabel={t('header.groupApps')}>{body}</Sheet> : (
    <Popover.Portal><Popover.Positioner anchor={anchor} side="bottom" align="end" sideOffset={4} collisionPadding={8}>
      <Popover.Popup aria-label={t('header.groupApps')} finalFocus={anchor} className={`${menuSurfaceClassName} max-h-[70vh] w-max min-w-40 max-w-[min(calc(var(--spacing)*80),calc(100vw-var(--spacing)*4))] overflow-y-auto`}>{body}</Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  )
}

function GroupAppRows({ chatId, installed, onClose }: { chatId: string; installed: InstalledApps; onClose: () => void }) {
  const { t } = useTranslation('messaging')
  const { apps, pending } = useGroupApps(chatId, installed)
  return (
    <>
      {apps.map((app) => (
          <div key={app.extensionId} data-app-id={app.extensionId} className="flex items-center gap-1">
            <Button variant="ghost" className="min-w-0 flex-1 justify-start" data-testid="group-apps-open" onClick={() => { openApp(app.extensionId, chatId); onClose() }}>
              <RailAppIcon app={app} className="gg-sidebar-launch-icon" /><span className="truncate">{app.name}</span>
            </Button>
          </div>
      ))}
      {pending ? <div className="px-2 py-2"><Unknown className="w-32" /></div>
        : apps.length === 0 && <p className="px-2 py-3 text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('header.noGroupApps')}</p>}
    </>
  )
}
