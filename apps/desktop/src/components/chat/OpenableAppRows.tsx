import { observer } from 'mobx-react-lite'
import { LOCAL_HOST, useInstalledApps, type RailApp } from '../../session/renderer/features/extensions/installed-extensions'
import { RailAppIcon } from '../RailAppIcon'
import { useTranslation } from 'react-i18next'
import { MenuItem, MenuSearch, useMenuSearch } from '../ui/Menu'
import { appIsRunning } from '../../session/renderer/features/extensions/app-dock'

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
        data-pane-opener=""
        icon={<RailAppIcon app={app} className="gg-sidebar-launch-icon" />}
        onClick={() => onOpen(app.extensionId)}
      >
        {app.name}
        {installed.state === 'value' && appIsRunning(installed.value, app.extensionId) && <i className="gg-sidebar-launch-running" aria-hidden="true" />}
      </MenuItem>
    ))}
  </>
})
