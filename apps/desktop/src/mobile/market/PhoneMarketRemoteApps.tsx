import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { AppConnectionListPlaceholder } from '@/components/assistant/AppConnectionHero'
import { PhoneAppManage } from '@/components/settings/PhoneAppManage'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { Button } from '@/components/ui/Button'
import { ReadingSlot } from '@/components/ui/ReadingSlot'
import { ExtensionMonogram } from '@renderer/features/extensions/panel/extension-monogram'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { ASSISTANT_APP_ID } from '@shared/extensions/assistant-entry'
import { localizedManifestText } from '@shared/extensions/catalog'
import { PhoneMarketRow } from './PhoneMarketList'
import { marketDeviceHost } from './marketDeviceHost'
import { useInstalledApps } from '@renderer/features/extensions/installed-extensions'

export function PhoneMarketRemoteApps({ device, devices, assistant = false }: {
  device: Device
  devices: readonly Device[]
  assistant?: boolean
}) {
  const { t } = useTranslation('main')
  const { locale, translate } = useSessionMessages()
  const host = useMemo(() => marketDeviceHost(device), [device])
  const hostKey = host.extensions.key
  const [selected, setSelected] = useState<string | null>(null)
  const inventory = useInstalledApps(hostKey, { read: device.is_online })
  return <>
    {!device.is_online && <SettingsNote role="status">{t('phoneMarket.deviceOffline')}</SettingsNote>}
    {/* Read before and offline: the list read stays. Unreadable: said with a retry. */}
    <ReadingSlot reading={inventory} placeholder={device.is_online ? <AppConnectionListPlaceholder /> : null}
      failed={(_error, retry) => <SettingsNote tone="danger" role="alert">{translate('extensions.loadFailed')}
        <Button size="sm" onClick={retry}>{translate('extensions.retry')}</Button>
      </SettingsNote>}>
      {(installed) => {
        const apps = installed.manifests.filter(app => !installed.isPreinstalled(app.id) && (app.id === ASSISTANT_APP_ID) === assistant)
        return <>
          {apps.map(app => {
            const name = localizedManifestText(app, locale).name
            return <PhoneMarketRow key={app.id} name={name} description={app.version}
              icon={<ExtensionMonogram name={name} iconDataUrl={installed.appIcons[app.id]} />}
              onOpen={() => setSelected(app.id)} testId={`phone-market-remote-app-${app.id}`} />
          })}
          {!apps.length && !assistant && <SettingsNote role="status">{t('phoneMarket.noInstalled')}</SettingsNote>}
        </>
      }}
    </ReadingSlot>
    {selected && <PhoneAppManage extensionId={selected} gone={false} onClose={() => setSelected(null)}
      remote={{ host: host.extensions, device, devices }} />}
  </>
}
