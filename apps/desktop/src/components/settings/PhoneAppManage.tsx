import { useId, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { followLink } from '../../lib/guguLinks'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { useTheme } from '@/store/theme'
import { sessionSkinClassName } from '../sessionpage/sessionSkin'
import { SessionUiTheme } from '../sessionpage/SessionUiTheme'
import { installedExtensionsStore as store } from '@/session/renderer/features/extensions/installed-extensions-store'
import { AppManagePage } from '@/session/renderer/features/extensions/panel/app-manage-page'
import { appLifecycle } from '@/session/renderer/features/extensions/panel/app-lifecycle'
import type { InstalledRowNotice } from '@/session/renderer/features/extensions/panel/installed-extension-row'
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages'
import { grantableBy } from '@/session/shared/extensions/attachment-install'
import { localizedManifestText } from '@/session/shared/extensions/catalog'
import { PHONE_CAPABILITIES, phoneApps } from '../appSlot/phoneApps'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { SettingsNote } from './SettingsPrimitives'
import { phoneProductApi } from './phoneMarketPage'

const log = rendererLogger('settings/phone-app-manage')

/**
 * An App's settings page on the phone: the desktop's page, with what this phone can manage. It has no agents and no App
 * background, and permissions are not taken back one by one here, so those hand it no action.
 */
export const PhoneAppManage = observer(function PhoneAppManage({ extensionId, updateVersion, gone, onClose, onViewInMarket }: {
  extensionId: string
  updateVersion?: string
  gone: boolean
  onClose: () => void
  onViewInMarket: () => void
}) {
  const { translate, locale } = useSessionMessages()
  const { theme } = useTheme()
  const titleId = useId()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ title: string; cause: string } | null>(null)
  const installed = store.manifests.find((manifest) => manifest.id === extensionId)
  if (!installed) return null
  const name = localizedManifestText(installed, locale).name
  const enabled = store.isEnabled(extensionId)
  const fromMarket = phoneApps.originOf(extensionId) === 'market'
  const autoUpdate = store.autoUpdates(extensionId)
  const main = store.mainTabOf(extensionId)
  const builtIn = store.isPreinstalled(extensionId)
  const notice: InstalledRowNotice | undefined = updateVersion
    ? { kind: 'update', version: updateVersion, releaseNotes: '' }
    : gone ? { kind: 'gone' } : undefined

  const run = async (title: string, action: () => Promise<{ success: boolean; error?: string }>) => {
    setBusy(true)
    setFailed(null)
    try {
      const result = await action()
      if (!result.success) {
        log.error({ extensionId, error: result.error }, 'Phone App action failed')
        setFailed({ title, cause: messageForUser(result.error) })
      }
      return result.success
    } catch (error) {
      log.error({ extensionId, error: String(error) }, 'Phone App action failed')
      setFailed({ title, cause: messageForUser(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet fullScreenMobile onClose={onClose} testId="phone-app-manage" ariaLabel={name}>
      <div className={`${sessionSkinClassName(theme)} phone-app-product`}>
        <SessionUiTheme theme={theme} skin>
          {failed ? <SettingsNote tone="danger" role="alert" data-testid="settings-apps-failed">{failed.title}: {failed.cause}</SettingsNote> : null}
          <AppManagePage
            manifest={grantableBy(installed, PHONE_CAPABILITIES)}
            iconDataUrl={store.appIcons[extensionId]}
            enabled={enabled}
            switching={busy}
            lifecycle={appLifecycle({ installed, enabled, preinstalled: builtIn, canOpen: Boolean(main) && !builtIn }, translate)}
            locale={locale}
            translate={translate}
            api={phoneProductApi}
            readOnly={busy}
            backLabel={translate('extensions.tabInstalled')}
            permissionsNote={translate(builtIn ? 'extensions.permissionsNoteBuiltIn' : 'extensions.permissionsNotePhone')}
            notice={notice}
            origin={builtIn ? 'preinstalled' : phoneApps.originOf(extensionId) ?? undefined}
            autoUpdate={autoUpdate === null ? undefined : { on: autoUpdate, onToggle: (on) => void run(translate('extensions.switchFailed'), () => phoneApps.setAutoUpdate(extensionId, on)) }}
            onBack={onClose}
            onLifecycle={() => {
              if (!enabled) void run(translate('extensions.switchFailed'), () => phoneApps.setEnabled(extensionId, true))
              else if (main) void followLink({ kind: 'app', extensionId, tab: main.kind.slice(extensionId.length + 1), path: '', query: {}, place: null })
            }}
            onInstallVersion={fromMarket ? (ref) => void run(translate('extensions.installFailed'), () => phoneApps.installFromMarket({ ref })) : undefined}
            onToggleEnabled={builtIn ? undefined : (on) => void run(translate('extensions.switchFailed'), () => phoneApps.setEnabled(extensionId, on))}
            onViewInMarket={fromMarket && !gone ? onViewInMarket : undefined}
            onOpenExternal={(url) => { window.open(url, '_blank', 'noopener,noreferrer') }}
            onUninstall={builtIn ? undefined : () => setAsking(true)}
          />
        </SessionUiTheme>
      </div>
      {asking ? (
        <Sheet onClose={() => setAsking(false)} testId="settings-apps-uninstall-sheet" titleId={titleId}>
          <div className="flex min-h-0 flex-1 flex-col gap-3 !p-5">
            <div id={titleId} className="text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">{translate('extensions.uninstallConfirmTitle', { name })}</div>
            <div className="text-[length:var(--font-body)] text-[var(--text-secondary)]">{translate('extensions.uninstallConfirmDescription', { name })}</div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsking(false)}>{translate('common.cancel')}</Button>
              <Button data-testid="settings-apps-uninstall-confirm" disabled={busy} onClick={() => void run(translate('extensions.uninstallFailed'), () => phoneApps.uninstall(extensionId)).then((done) => {
                setAsking(false)
                if (done) onClose()
              })}>{translate('extensions.uninstallAction')}</Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </Sheet>
  )
})
