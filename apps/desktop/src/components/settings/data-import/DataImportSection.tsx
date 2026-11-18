import { useEffect, useId, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { ChevronDown, RefreshCw, X } from '@/lib/icons'
import { notify } from '@/lib/notices'
import { openLink } from '@/lib/guguLinks'
import { useAuth } from '@/store/auth'
import { useReplicas } from '@/lib/replica'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { Collapse } from '@/components/ui/Collapse'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { importDeviceChoices } from '@renderer/features/session-import/import-device'
import { ImportSourceIcon, LocalImportSources, RemoteImportSources } from './ImportSourceRows'
import { importedSourceHistory, importSourceCounts } from './import-replicas'
import { importJobs, type ImportedEntry } from './import-queue'
import { importProviders, registerExtraImportProviders, type ImportProvider } from './import-providers'
import { ImportSyncSettings } from './ImportSyncSettings'
import './data-import.css'

type HistoryGroup = { id: string; provider: ImportProvider; finishedAt: number; entries: readonly ImportedEntry[] }

function HistoryEntry({ group, onClose }: { group: HistoryGroup; onClose: () => void }) {
  const { t, i18n } = useTranslation('main')
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const date = new Date(group.finishedAt)
  const timestamp = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }).format(date)
  const { entries, provider } = group

  async function openSession(session: ImportedEntry) {
    try {
      if (provider.openImportedSession) {
        await provider.openImportedSession(session, session.deviceId)
        return
      } else if (session.projectId) {
        await openLink({ kind: 'session', projectId: session.projectId, sessionId: session.sessionId,
          ...(session.deviceId ? { deviceId: session.deviceId } : {}) })
      } else {
        notify({ tier: 'error', title: t('settings.dataImport.openFailed') })
        return
      }
      onClose()
    } catch {
      notify({ tier: 'error', title: t('settings.dataImport.openFailed') })
    }
  }

  return (
    <div className="gg-import-history-entry">
      <Button variant="ghost" className="gg-import-history-trigger" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen(!open)}>
        <ImportSourceIcon provider={provider} />
        <span className="gg-import-copy">
          <span className="gg-import-name">{provider.label}</span>
          <span className="gg-import-meta">{timestamp}<span>{t('settings.dataImport.result', { count: entries.length })}</span></span>
        </span>
        <ChevronDown size={16} className="gg-import-chevron" />
      </Button>
      <Collapse open={open} id={panelId} onOpenChange={setOpen}>
        <ul className="gg-import-history-sessions">
          {entries.map((session) => (
            <li key={`${session.deviceId ?? ''}:${session.sessionId}`}>
              <Button variant="ghost" className="gg-import-history-session" onClick={() => { void openSession(session) }}>
                <span className="truncate" title={session.title}>{session.title}</span>
                {session.deviceName && <span className="gg-import-device">{session.deviceName}</span>}
              </Button>
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  )
}

const NO_EXTRA_PROVIDERS: readonly ImportProvider[] = []
type ImportTab = 'apps' | 'devices'

export const DataImportSection = observer(function DataImportSection({
  onClose, extraProviders = NO_EXTRA_PROVIDERS,
}: { onClose: () => void; extraProviders?: readonly ImportProvider[] }) {
  const { t } = useTranslation('main')
  const { user } = useAuth()
  const [tab, setTab] = useState<ImportTab>('apps')
  const panelId = useId()
  const jobs = useSyncExternalStore(importJobs.subscribe, importJobs.getSnapshot)
  const ownerJobs = jobs.filter(({ ownerId }) => ownerId === user?.id)
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
  const providers = [...extraProviders, ...importProviders]
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
    <div className="gg-data-import">
      <IconButton shape="pill" size="lg" className="gg-import-close bg-foreground/[0.06]" aria-label={t('settings.close')} onClick={onClose}><X /></IconButton>
      <div className="gg-import-toolbar">
        <SegmentedTabs<ImportTab> ariaLabel={t('settings.nav.data-import')} value={tab} onChange={setTab} items={[
          { value: 'apps', label: t('settings.dataImport.appTab'), panelId },
          { value: 'devices', label: t('settings.dataImport.deviceTab'), panelId },
        ]} />
        {local && <IconButton aria-label={t('settings.dataImport.refresh')} title={t('settings.dataImport.refresh')}
          onClick={() => { void importSourceCounts.refresh() }}><RefreshCw size={16} /></IconButton>}
      </div>
      <div id={panelId} className="gg-import-stack" role="tabpanel"
        aria-label={t(local ? 'settings.dataImport.appTab' : 'settings.dataImport.deviceTab')}>
        {user && (local ? (
          <>
            <LocalImportSources providers={providers} ownerId={user.id} jobs={ownerJobs} />
            <ImportSyncSettings ownerId={user.id} />
          </>
        ) : (
          <>
            <p className="gg-import-meta">{t('settings.dataImport.remoteDescription')}</p>
            <RemoteImportSources machines={machines} providers={providers.filter((provider) => !provider.localOnly)} ownerId={user.id} jobs={ownerJobs} />
          </>
        ))}
        {history.length > 0 && (
          <section className="gg-import-history">
            <h3>{t('settings.dataImport.history')}</h3>
            <div className="gg-import-history-list">
              {history.map((group) => <HistoryEntry key={group.id} group={group} onClose={onClose} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  )
})
