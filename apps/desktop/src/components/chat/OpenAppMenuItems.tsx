import { observer } from 'mobx-react-lite'
import { installedExtensions, LOCAL_HOST, useInstalledApps, type RailApp } from '../../session/renderer/features/extensions/installed-extensions'
import { HERE_HOST } from '../appSlot/hereHost'
import { Unknown } from '../ui/Unknown'
import { RefreshFailed } from '../ui/RefreshFailed'
import { openApp } from '../appSlot/useOpenApp'
import { RailAppIcon } from '../RailAppIcon'
import { LayoutGrid } from '@/lib/icons'
import { useTranslation } from 'react-i18next'
import { MenuFold, MenuItem, MenuRow, MenuSearch, MenuSeparator, useMenuSearch } from '../ui/Menu'
import { appIsRunning } from '../../session/renderer/features/extensions/app-dock'

/**
 * 「在本群打开」(app-redesign §5)的常驻入口:卡片划走以后,这台设备上装着、开着、有自己页面的 App 仍从页头 ⋯ 在这个对话的右栏
 * 打开 —— 群和私聊的页头(ChatHeaderActions);走卡片「打开」的同一条 `openApp`。
 * 列表与最左栏右键「App」同一份(`openableApps`)。没有可开的 App 时什么都不画。
 */
export function OpenAppMenuItems({ chatId, separated }: {
  chatId: string
  /** 前面还有别的菜单项:先画一条分组线。 */
  separated?: boolean
}) {
  const installed = useInstalledApps(HERE_HOST)
  if (!HERE_HOST) return null
  // Not known yet: the fold's row holds its place (❌ no fold, then one appearing under the pointer).
  if (installed.state === 'unknown') return <>{separated && <MenuSeparator />}<MenuRow><Unknown className="w-32" /></MenuRow></>
  if (installed.state === 'error') {
    return <>{separated && <MenuSeparator />}<MenuRow><RefreshFailed error={installed.error} onRetry={() => { if (HERE_HOST) void installedExtensions.refresh(HERE_HOST) }} /></MenuRow></>
  }
  return <OpenAppFold chatId={chatId} separated={separated} apps={installed.value.openableApps} />
}

function OpenAppFold({ chatId, separated, apps }: { chatId: string; separated?: boolean; apps: readonly RailApp[] }) {
  const { t } = useTranslation('messaging')
  const { t: tc } = useTranslation('common')
  const { search, shown } = useMenuSearch(apps, app => app.name, { placeholder: tc('menu.search'), noResults: tc('menu.noResults') })
  if (apps.length === 0) return null
  return (
    <>
      {separated && <MenuSeparator />}
      <MenuFold icon={<LayoutGrid size={16} />} label={t('header.openApp')} search={search} data-testid="chat-header-menu-apps">
        {shown.map((app) => (
          <MenuItem
            key={app.extensionId}
            data-testid="chat-header-menu-app"
            onClick={() => openApp(app.extensionId, chatId)}
            icon={<RailAppIcon app={app} className="gg-sidebar-launch-icon" />}
          >{app.name}</MenuItem>
        ))}
      </MenuFold>
    </>
  )
}

/** The rail's right-click list of Apps: a search over it once it is long, as every long menu list. */
export const OpenableAppRows = observer(function OpenableAppRows({ apps, onOpen }: { apps: readonly RailApp[]; onOpen: (appId: string) => void }) {
  const { t } = useTranslation('common')
  const { search, shown } = useMenuSearch(apps, app => app.name, { placeholder: t('menu.search'), noResults: t('menu.noResults') })
  const installed = useInstalledApps(LOCAL_HOST)
  return <>
    {search && <MenuSearch {...search} />}
    {shown.map((app) => (
      <MenuItem
        key={app.extensionId}
        className="gg-sidebar-launch-item"
        icon={<RailAppIcon app={app} className="gg-sidebar-launch-icon" />}
        onClick={() => onOpen(app.extensionId)}
      >
        {app.name}
        {installed.state === 'value' && appIsRunning(installed.value, app.extensionId) && <i className="gg-sidebar-launch-running" aria-hidden="true" />}
      </MenuItem>
    ))}
  </>
})
