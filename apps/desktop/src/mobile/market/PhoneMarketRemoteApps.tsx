import { useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { AppConnectionListPlaceholder } from '@/components/assistant/AppConnectionHero'
import { PhoneAppManage } from '@/components/settings/PhoneAppManage'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { Button } from '@/components/ui/Button'
import { ExtensionMonogram } from '@renderer/features/extensions/panel/extension-monogram'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { ASSISTANT_APP_ID } from '@shared/extensions/assistant-entry'
import { localizedManifestText } from '@shared/extensions/catalog'
import { PhoneMarketRow } from './PhoneMarketList'
import { marketDeviceHost } from './marketDeviceHost'

export const PhoneMarketRemoteApps = observer(function PhoneMarketRemoteApps({ device, devices, assistant = false }: {
  device: Device
  devices: readonly Device[]
  assistant?: boolean
}) {
  const { t } = useTranslation('main')
  const { locale, translate } = useSessionMessages()
  const host = useMemo(() => marketDeviceHost(device), [device])
  const { store } = host.extensions
  const [selected, setSelected] = useState<string | null>(null)
  const [attempt, retry] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!device.is_online) return
    let active = true
    void store.load().then(() => { if (active) setFailed(false) }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [device.is_online, store, attempt])
  const apps = store.manifests.filter(app => !store.isPreinstalled(app.id) && (app.id === ASSISTANT_APP_ID) === assistant)
  return <>
    {!device.is_online ? <SettingsNote role="status">{t('phoneMarket.deviceOffline')}</SettingsNote>
      : failed ? <SettingsNote tone="danger" role="alert">{translate('extensions.loadFailed')}
        <Button size="sm" onClick={() => retry(value => value + 1)}>{translate('extensions.retry')}</Button>
      </SettingsNote>
        : !store.isLoaded ? <AppConnectionListPlaceholder /> : null}
    {apps.map(app => {
      const name = localizedManifestText(app, locale).name
      return <PhoneMarketRow key={app.id} name={name} description={app.version}
        icon={<ExtensionMonogram name={name} iconDataUrl={store.appIcons[app.id]} />}
        onOpen={() => setSelected(app.id)} testId={`phone-market-remote-app-${app.id}`} />
    })}
    {store.isLoaded && !apps.length && !assistant && <SettingsNote role="status">{t('phoneMarket.noInstalled')}</SettingsNote>}
    {selected && <PhoneAppManage extensionId={selected} gone={false} onClose={() => setSelected(null)}
      remote={{ host: host.extensions, device, devices }} />}
  </>
})
