import type { Device } from '@gugu/core/shared/types/chat'
import { useId, useState } from 'react'
import { followLink } from '../../lib/guguLinks'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { useTheme } from '@/store/theme'
import { sessionSkinClassName } from '../sessionpage/sessionSkin'
import { SessionUiTheme } from '../sessionpage/SessionUiTheme'
import { fetchInstalledApps, installedExtensions, PHONE_HOST, setAutoUpdate, useInstalledApps } from '@/session/renderer/features/extensions/installed-extensions'
import type { ExtensionsHost } from '@renderer/features/extensions/extensions-host'
import { installedElsewhere } from '@renderer/features/extensions/installed-elsewhere'
import { setExtensionEnabled } from '@renderer/features/extensions/set-extension-enabled'
import { machineRpc } from '@/mobile/agent-watch/sessionpage-rpc'
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
export function PhoneAppManage({ extensionId, updateVersion, gone, onClose, onViewInMarket, remote }: {
  extensionId: string
  updateVersion?: string
  gone: boolean
  onClose: () => void
  onViewInMarket?: () => void
  remote?: { host: ExtensionsHost; device: Device; devices: readonly Device[] }
}) {
  const { translate, locale } = useSessionMessages()
  const { theme } = useTheme()
  const titleId = useId()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ title: string; cause: string } | null>(null)
  const hostKey = remote?.host.key ?? PHONE_HOST
  const reading = useInstalledApps(hostKey)
  // Opened from a row of the list, so it is read; were it not (yet), nothing to manage is drawn until it is.
  const store = reading.state === 'value' ? reading.value : null
  const installed = store?.manifests.find((manifest) => manifest.id === extensionId)
  if (!store || !installed) return null
  const name = localizedManifestText(installed, locale).name
  const enabled = store.isEnabled(extensionId)
  const origin = remote ? store.origins[extensionId] : phoneApps.originOf(extensionId) ?? undefined
  const fromMarket = origin === 'market'
  const autoUpdate = store.autoUpdates(extensionId)
  const main = remote ? undefined : store.mainTabOf(extensionId)
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

  const changeEnabled = (on: boolean) => run(translate('extensions.switchFailed'), async () => {
    if (!remote) return phoneApps.setEnabled(extensionId, on)
    await setExtensionEnabled(installed, on, remote.host)
    return { success: true }
  })
  const changeAutoUpdate = (on: boolean) => run(translate('extensions.switchFailed'), async () => {
    if (!remote) return phoneApps.setAutoUpdate(extensionId, on)
    await setAutoUpdate(hostKey, extensionId, on)
    return { success: true }
  })
  const uninstall = () => run(translate('extensions.uninstallFailed'), async () => {
    if (!remote) return phoneApps.uninstall(extensionId)
    const lastAnywhere = !await installedElsewhere(extensionId, remote.device.device_id, {
      devices: () => remote.devices.map(device => ({ id: device.device_id, isOnline: device.is_online })),
      installed: async deviceId => {
        if (!deviceId) {
          const phone = await fetchInstalledApps(PHONE_HOST)
          if (phone.unreadable) throw new Error('Unreadable phone App inventory')
          return phone.manifests.map(app => app.id)
        }
        const result = await machineRpc(deviceId).extensions.list()
        if (!result.success || !result.data) throw new Error(result.error ?? 'Unreadable App inventory')
        return result.data.extensions.map(app => app.id)
      },
    })
    const result = await remote.host.api.uninstall({ extensionId, lastAnywhere })
    if (result.success) await installedExtensions.refresh(hostKey)
    return result
  })

  return (
    <Sheet fullScreenMobile onClose={onClose} testId="phone-app-manage" ariaLabel={name}>
      <div className={`${sessionSkinClassName(theme)} phone-app-product`}>
        <SessionUiTheme theme={theme} skin>
          {failed ? <SettingsNote tone="danger" role="alert" data-testid="settings-apps-failed">{failed.title}: {failed.cause}</SettingsNote> : null}
          <AppManagePage
            manifest={remote ? installed : grantableBy(installed, PHONE_CAPABILITIES)}
            iconDataUrl={store.appIcons[extensionId]}
            enabled={enabled}
            switching={busy}
            lifecycle={appLifecycle({ installed, enabled, preinstalled: builtIn, canOpen: Boolean(main) && !builtIn }, translate)}
            locale={locale}
            translate={translate}
            api={remote?.host.api ?? phoneProductApi}
            hostKey={hostKey}
            machine={remote?.device.label || remote?.device.hostname}
            readOnly={busy || remote?.device.is_online === false}
            backLabel={translate('extensions.tabInstalled')}
            permissionsNote={remote ? undefined : translate(builtIn ? 'extensions.permissionsNoteBuiltIn' : 'extensions.permissionsNotePhone')}
            notice={notice}
            origin={builtIn ? 'preinstalled' : origin}
            autoUpdate={autoUpdate === null ? undefined : { on: autoUpdate, onToggle: (on) => void changeAutoUpdate(on) }}
            onBack={onClose}
            onLifecycle={() => {
              if (!enabled) void changeEnabled(true)
              else if (main) void followLink({ kind: 'app', extensionId, tab: main.kind.slice(extensionId.length + 1), path: '', query: {}, place: null })
            }}
            onInstallVersion={fromMarket && !remote ? (ref) => void run(translate('extensions.installFailed'), () => phoneApps.installFromMarket({ ref })) : undefined}
            onToggleEnabled={builtIn ? undefined : (on) => void changeEnabled(on)}
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
              <Button data-testid="settings-apps-uninstall-confirm" disabled={busy} onClick={() => void uninstall().then((done) => {
                setAsking(false)
                if (done) onClose()
              })}>{translate('extensions.uninstallAction')}</Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </Sheet>
  )
}
