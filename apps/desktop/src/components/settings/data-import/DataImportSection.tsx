import { categoryLabelKey, categoryHistoryReading, outcomeLabelKey } from './environment-import-view'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { useEffect, useId, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from '@/lib/icons'
import { notify } from '@/lib/notices'
import { openLink } from '@/lib/guguLinks'
import { useAuth } from '@/store/auth'
import { useReplicas } from '@/lib/replica'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { Button } from '@/components/ui/Button'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store'
import { importDeviceChoices } from '@renderer/features/session-import/import-device'
import { FoldingRow, ImportSourceIcon, LocalImportSources, RemoteImportSources } from './ImportSourceRows'
import { importedSourceHistory, importSourceCounts } from './import-replicas'
import { importJobs, type ImportedEntry } from './import-queue'
import { importProviders, registerExtraImportProviders, type ImportProvider } from './import-providers'
import { ImportSyncSettings } from './ImportSyncSettings'
import { SettingsGroup, SettingsPage, SettingsRow } from '../SettingsPrimitives'
import type { EnvironmentImportCategory } from '@shared/core/session-import/environment-import'
import './data-import.css'
import { importFailureDescription } from './import-failure-copy'

type HistoryGroup = { id: string; provider: ImportProvider; finishedAt: number; entries: readonly ImportedEntry[] }

function HistoryEntry({ group, onClose }: { group: HistoryGroup; onClose: () => void }) {
  const { t, i18n } = useTranslation('main')
  const [open, setOpen] = useState(false)
  const date = new Date(group.finishedAt)
  const timestamp = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }).format(date)
  const { entries, provider } = group

  async function openSession(session: ImportedEntry) {
    try {
      if (provider.openImportedSession) {
        await provider.openImportedSession(session, session.deviceId)
        return
      }
      await openLink({ kind: 'session', sessionId: session.sessionId, ...(session.deviceId ? { deviceId: session.deviceId } : {}) })
      onClose()
    } catch {
      notify({ tier: 'error', title: t('settings.dataImport.openFailed') })
    }
  }

  return (
    <FoldingRow label={provider.label} open={open} onToggle={() => setOpen(!open)}
      leading={<ImportSourceIcon provider={provider} />} title={provider.label}
      description={<>{timestamp} · {t('settings.dataImport.result', { count: entries.length })}</>}>
      {entries.map((session) => (
        <SettingsRow key={`${session.deviceId ?? ''}:${session.sessionId}`} title={<span className="truncate" title={session.title}>{session.title}</span>}
          control={session.deviceName ? <span className="gg-settings-row-value">{session.deviceName}</span> : undefined}
          onClick={() => { void openSession(session) }} />
      ))}
    </FoldingRow>
  )
}

const NO_EXTRA_PROVIDERS: readonly ImportProvider[] = []
type ImportTab = 'apps' | 'devices'

export const DataImportSection = observer(function DataImportSection({
  onClose, extraProviders = NO_EXTRA_PROVIDERS, localDetails, machineDetails,
}: { onClose: () => void; extraProviders?: readonly ImportProvider[]; localDetails?: ReactNode; machineDetails?: (machine: string) => ReactNode }) {
  const { t } = useTranslation('main')
  const { user } = useAuth()
  const importSettings = useAppSettingsKey('dataImport').settings
  const selectedMachine = settingsDeviceStore.selected
  const [tab, setTab] = useState<ImportTab>(selectedMachine === 'local' ? 'apps' : 'devices')
  // A subscription row or a first-install notice can open an already mounted import page.
  useEffect(() => { setTab(selectedMachine === 'local' ? 'apps' : 'devices') }, [selectedMachine])
  const panelId = useId()
  const jobs = useSyncExternalStore(importJobs.subscribe, importJobs.getSnapshot)
  const ownerJobs = jobs.filter(({ ownerId }) => ownerId === user?.id)
  const completedCategories = ownerJobs.flatMap(job => job.finishedAt && job.result?.details.length
    ? [{ providerId: job.provider.id, finishedAt: job.finishedAt, items: job.result.details }] : [])
  const categoryHistory = categoryHistoryReading(completedCategories, importSettings.state === 'value'
    ? { state: 'value', value: importSettings.value.value } : importSettings, user?.id)
  useEffect(() => { remoteHostsStore.start() }, [])
  useLayoutEffect(() => {
    const unregister = registerExtraImportProviders(extraProviders)
    for (const { id } of extraProviders) {
      void importSourceCounts.refresh(id)
      void importedSourceHistory.refresh(id)
    }
    return unregister
  }, [extraProviders])
  const machines = importDeviceChoices(t('settings.dataImport.thisComputer'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => device)).filter((machine) => !machine.isLocal)
  const providers = [...importProviders, ...extraProviders]
  const durableProviders = providers.filter((provider) => provider.listHistory)
  const durable = useReplicas(importedSourceHistory, durableProviders.map(({ id }) => [id]))
  const local = tab === 'apps'
  const history: HistoryGroup[] = ownerJobs.flatMap((job) => {
    if (!job.finishedAt || !job.result) return []
    const entries = job.result.imported.filter(({ deviceId }) => (deviceId === null) === local)
    return entries.length ? [{ id: job.id, provider: job.provider, finishedAt: job.finishedAt, entries }] : []
  })
  if (local) {
    for (const [index, provider] of durableProviders.entries()) {
      const reading = durable[index]
      if (reading?.state !== 'value' || reading.value.length === 0) continue
      const shownIds = new Set(history.filter((group) => group.provider.id === provider.id).flatMap((group) => group.entries.map(({ sessionId }) => sessionId)))
      const entries = reading.value.filter(({ sessionId }) => !shownIds.has(sessionId))
      if (entries.length > 0) history.push({
        id: provider.id, provider, finishedAt: Math.max(...entries.map(({ importedAt }) => importedAt)),
        entries: entries.map((session) => ({ ...session, deviceId: null })),
      })
    }
  }
  history.sort((a, b) => b.finishedAt - a.finishedAt)

  return (
    <SettingsPage className="gg-data-import">
      <div className="gg-import-toolbar">
        <SegmentedTabs<ImportTab> ariaLabel={t('settings.nav.data-import')} value={tab} onChange={(next) => {
          setTab(next)
          if (next === 'apps') settingsDeviceStore.select('local')
          else if (selectedMachine === 'local' && machines[0]) settingsDeviceStore.select(machines[0].id)
        }} items={[
          { value: 'apps', label: t('settings.dataImport.thisComputer'), panelId },
          { value: 'devices', label: t('settings.dataImport.machineList'), panelId },
        ]} />
        {local && <Button variant="ghost" size="sm" onClick={() => { void importSourceCounts.refresh() }}>
          <RefreshCw size={14} />{t('settings.dataImport.refresh')}</Button>}
      </div>
      <div id={panelId} className="gg-settings-page" role="tabpanel"
        aria-label={t(local ? 'settings.dataImport.appTab' : 'settings.dataImport.deviceTab')}>
        {user && (local ? (
          <>
            <LocalImportSources providers={providers} ownerId={user.id} jobs={ownerJobs} />
            {localDetails}
            <ImportSyncSettings ownerId={user.id} />
          </>
        ) : (
          <RemoteImportSources machines={machines} selectedMachine={selectedMachine === 'local' ? undefined : selectedMachine} onMachineChange={(machine) => settingsDeviceStore.select(machine)} machineDetails={machineDetails} providers={providers.filter((provider) => !provider.localOnly)} ownerId={user.id} jobs={ownerJobs} />
        ))}
        {local && user && (categoryHistory.state !== 'value' || categoryHistory.items.length > 0) && <SettingsGroup title={t('settings.dataImport.categoryResults')}>
          {categoryHistory.state !== 'value' && <SettingsRow title={t('settings.dataImport.reading')} control={<LoadingIndicator size="inline" />} />}
          {categoryHistory.items.map(group => <CategoryResult key={`${group.providerId}:${group.finishedAt}`} items={group.items} />)}
        </SettingsGroup>}
        {history.length > 0 && (
          <SettingsGroup title={t('settings.dataImport.history')}>
            {history.map((group) => <HistoryEntry key={group.id} group={group} onClose={onClose} />)}
          </SettingsGroup>
        )}
      </div>
    </SettingsPage>
  )
})

type CategoryItems = readonly { id: string; title: string; category: EnvironmentImportCategory; status?: string; reason?: string }[]

function CategoryResult({ items }: { items: CategoryItems }) {
  const { t } = useTranslation('main')
  const [open, setOpen] = useState(false)
  const label = items[0] ? t(categoryLabelKey(items[0].category)) : ''
  const failed = items.filter(item => item.status && !['imported', 'existing'].includes(item.status)).length
  return (
    <FoldingRow label={label} open={open} onToggle={() => setOpen(!open)} title={label}
      description={t('settings.dataImport.categoryResultSummary', { count: items.filter(item => item.status === 'imported').length, existing: items.filter(item => item.status === 'existing').length, failed })}>
      {items.map(item => <SettingsRow key={item.id} title={item.title} control={<span className="gg-settings-row-value">{importFailureDescription(item.reason) ?? t(outcomeLabelKey(item.status, item.reason))}</span>} />)}
      {items.some(item => item.category === 'connectors') && <SettingsRow description={t('settings.dataImport.configurationOnly')} />}
    </FoldingRow>
  )
}
