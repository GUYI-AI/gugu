import { metadataSeparator } from '@/i18n/format'
import { ExtensionMonogram } from '@/session/renderer/features/extensions/panel/extension-monogram'
import { Unknown } from '../ui/Unknown'
import { RefreshFailed } from '../ui/RefreshFailed'
import { ResourceMenu } from '../ResourceMenu'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from '@/lib/icons'
import { PHONE_HOST, useInstalledApps, type InstalledApps, type MarketUpdates } from '../../session/renderer/features/extensions/installed-extensions'
import type { Reading } from '../../lib/replica'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'
import { ASSISTANT_APP_ID } from '@shared/extensions/assistant-entry'
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
const installedApps = (installed: InstalledApps, assistant: boolean): { manifest: ExtensionManifest; from: string | null; enabled: boolean }[] =>
  installed.manifests
    .filter((manifest) => !installed.isPreinstalled(manifest.id) && (manifest.id === ASSISTANT_APP_ID) === assistant)
    .map((manifest) => ({
      manifest,
      from: installed.publishers[manifest.id]?.name ?? null,
      enabled: installed.isEnabled(manifest.id),
    }))
const unusableApps = (installed: InstalledApps, assistant: boolean): { id: string; reason: string }[] =>
  assistant ? [] : installed.invalid.map((entry) => ({ id: entry.dirName, reason: entry.reason }))

/** `offered` (`marketUpdates('phone')`): while unknown a row says nothing about versions. */
export function AppsSection({ offered, onManage, assistant = false, hideEmpty = false }: {
  offered: Reading<MarketUpdates>
  onManage: (id: string) => void
  /** The assistant's own row only (the assistant page), or every other App. */
  assistant?: boolean
  hideEmpty?: boolean
}) {
  const { t, i18n } = useTranslation('main')
  const { t: tm } = useTranslation('messaging')
  const titleId = useId()
  // Unknown draws placeholder rows (❌ "no Apps installed" first).
  const installed = useInstalledApps(PHONE_HOST)
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const uninstall = async (id: string) => {
    setBusy(true)
    const result = await phoneApps.uninstall(id)
    setBusy(false)
    setAsking(null)
    setFailed(result.success ? null : result.error)
  }

  // The rows below are drawn only once what is installed is read (the unknown and error branches come first).
  const lists = installed.state === 'value' ? { apps: installedApps(installed.value, assistant), unusable: unusableApps(installed.value, assistant) } : null
  if (hideEmpty && lists && !lists.apps.length && !lists.unusable.length) return null

  return (
    <SettingsPage data-testid="settings-apps">
      {/* The offers read before, their read again failing: the 「更新到 vX」 read stay, the failure said with a retry (❌ drawn as
          current). Unreachable with none read offers nothing, the version each row has is still true. The installed list's own
          failure is said by MobileAppsSection's banner. */}
      <SettingsGroup note={!assistant ? t('settings.apps.intro') : undefined}
        footer={offered.state === 'value' ? <RefreshFailed reading={offered} /> : undefined}>
        {installed.state === 'unknown' ? (
          <SettingsRow data-testid="settings-apps-unknown" leading={<Unknown className="mk-icon" />} title={<Unknown className="w-24" />} description={<Unknown className="w-32" />} />
        ) : installed.state === 'error' ? (
          <SettingsRow data-testid="settings-apps-unreadable" description={installed.error.message} />
        ) : lists!.apps.length === 0 && lists!.unusable.length === 0 ? (
          <SettingsRow description={t('settings.apps.empty')} data-testid="settings-apps-empty" />
        ) : (
          <>
            {lists!.apps.map(({ manifest, from, enabled }) => (
              <ResourceMenu key={manifest.id} resource={{ kind: 'app', target: { kind: 'app-detail', extensionId: manifest.id } }}>
                <SettingsRow
                  data-app-id={manifest.id}
                  data-testid="settings-apps-row"
                  leading={<span className="mk-icon"><ExtensionMonogram name={localizedManifestText(manifest, i18n.language).name} iconDataUrl={installed.value.appIcons[manifest.id]} /></span>}
                  onClick={() => onManage(manifest.id)}
                  // 名字跟界面语言走,和电脑上 App 页同一个挑法(manifest 的 localized)。
                  title={localizedManifestText(manifest, i18n.language).name}
                  // 市场还没回过话:版本那一句画占位,❌ 先写「来自市场 v1.2」再改成「更新到 v1.3」。
                  description={offered.state === 'unknown' ? <Unknown className="w-32" /> : [
                    // The market unreachable is an answer too: each row says the version it has, and offers nothing.
                    offered.state === 'value' && offered.value.offered[manifest.id]
                      ? t('settings.apps.updateTo', { version: offered.value.offered[manifest.id] })
                      : phoneApps.originOf(manifest.id) === 'market'
                        ? t('settings.apps.fromMarket', { version: manifest.version })
                        : t('settings.apps.from', { version: manifest.version, name: from ?? '—' }),
                    ...(enabled ? [] : [translateSessionMessage('extensions.switchedOff')]),
                    ...(offered.state === 'value' && offered.value.gone.includes(manifest.id) ? [translateSessionMessage('extensions.rowGone')] : []),
                  ].join(metadataSeparator())}
                  control={<ChevronRight className="size-4 text-[var(--text-secondary)]" />}
                />
              </ResourceMenu>
            ))}
            {lists!.unusable.map(({ id, reason }) => (
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
