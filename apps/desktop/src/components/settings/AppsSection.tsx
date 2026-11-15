import { ExtensionMonogram } from '@/session/renderer/features/extensions/panel/extension-monogram'
import { ResourceMenu } from '../ResourceMenu'
import { comparer, reaction } from 'mobx'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from '@/lib/icons'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import { localizedManifestText } from '../../session/shared/extensions/catalog'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { phoneApps } from '../appSlot/phoneApps'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'

/**
 * 「App」 on the phone (L9): the Apps installed on it — from cards in chats and from the market. A row is a name and how it
 * stands; everything about one is on its settings page (`onManage`). The ones gugu ships are not listed. One this build
 * cannot run has no such page: its refusal is said as it is, and it can still be removed, as any App the phone cannot read must be.
 */
export function AppsSection({ updates, gone, onManage }: { updates: Record<string, string>; gone: readonly string[]; onManage: (id: string) => void }) {
  const { t, i18n } = useTranslation('main')
  const { t: tm } = useTranslation('messaging')
  const titleId = useId()
  const [apps, setApps] = useState<{ manifest: ExtensionManifest; from: string | null; enabled: boolean }[]>([])
  const [unusable, setUnusable] = useState<{ id: string; reason: string }[]>([])
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const off = reaction(
      () => installedExtensionsStore.invalid.map((entry) => ({ id: entry.dirName, reason: entry.reason })),
      setUnusable,
      { fireImmediately: true, equals: comparer.structural },
    )
    const offApps = reaction(
      () =>
        installedExtensionsStore.manifests
          .filter((manifest) => !installedExtensionsStore.isPreinstalled(manifest.id))
          .map((manifest) => ({
            manifest,
            from: installedExtensionsStore.publishers[manifest.id]?.name ?? null,
            enabled: installedExtensionsStore.isEnabled(manifest.id),
          })),
      setApps,
      { fireImmediately: true, equals: comparer.structural },
    )
    return () => {
      off()
      offApps()
    }
  }, [])

  const uninstall = async (id: string) => {
    setBusy(true)
    const result = await phoneApps.uninstall(id)
    setBusy(false)
    setAsking(null)
    setFailed(result.success ? null : result.error)
  }

  return (
    <SettingsPage data-testid="settings-apps">
      <SettingsGroup note={t('settings.apps.intro')}>
        {apps.length === 0 && unusable.length === 0 ? (
          <SettingsRow description={t('settings.apps.empty')} data-testid="settings-apps-empty" />
        ) : (
          <>
            {apps.map(({ manifest, from, enabled }) => (
              <ResourceMenu key={manifest.id} resource={{ kind: 'app', target: { kind: 'app-detail', extensionId: manifest.id } }}>
                <SettingsRow
                  data-app-id={manifest.id}
                  data-testid="settings-apps-row"
                  leading={<span className="mk-icon"><ExtensionMonogram name={localizedManifestText(manifest, i18n.language).name} iconDataUrl={installedExtensionsStore.appIcons[manifest.id]} /></span>}
                  onClick={() => onManage(manifest.id)}
                  // 名字跟界面语言走,和电脑上 App 页同一个挑法(manifest 的 localized)。
                  title={localizedManifestText(manifest, i18n.language).name}
                  description={[
                    updates[manifest.id]
                      ? t('settings.apps.updateTo', { version: updates[manifest.id] })
                      : phoneApps.originOf(manifest.id) === 'market'
                        ? t('settings.apps.fromMarket', { version: manifest.version })
                        : t('settings.apps.from', { version: manifest.version, name: from ?? '—' }),
                    ...(enabled ? [] : [translateSessionMessage('extensions.switchedOff')]),
                    ...(gone.includes(manifest.id) ? [translateSessionMessage('extensions.rowGone')] : []),
                  ].join(' · ')}
                  control={<ChevronRight className="size-4 text-[var(--text-secondary)]" />}
                />
              </ResourceMenu>
            ))}
            {unusable.map(({ id, reason }) => (
              <SettingsRow
                key={id}
                data-app-id={id}
                data-testid="settings-apps-unusable"
                title={id}
                description={reason}
                control={
                  <Button size="sm" variant="ghost" data-testid="settings-apps-uninstall" onClick={() => setAsking(id)}>
                    {translateSessionMessage('extensions.uninstallAction')}
                  </Button>
                }
              />
            ))}
          </>
        )}
      </SettingsGroup>
      {failed ? (
        <SettingsNote tone="danger" data-testid="settings-apps-failed">
          {translateSessionMessage('extensions.uninstallFailed')}: {failed}
        </SettingsNote>
      ) : null}
      {asking ? (
        <Sheet onClose={() => setAsking(null)} testId="settings-apps-uninstall-sheet" titleId={titleId}>
          <div className="flex min-h-0 flex-1 flex-col gap-3 !p-5">
            <div id={titleId} className="text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">
              {translateSessionMessage('extensions.uninstallConfirmTitle', { name: asking })}
            </div>
            <div className="text-[length:var(--font-body)] text-[var(--text-secondary)]">
              {translateSessionMessage('extensions.uninstallConfirmDescription', { name: asking })}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsking(null)}>
                {tm('common.cancel')}
              </Button>
              <Button data-testid="settings-apps-uninstall-confirm" disabled={busy} onClick={() => void uninstall(asking)}>
                {translateSessionMessage('extensions.uninstallAction')}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </SettingsPage>
  )
}
