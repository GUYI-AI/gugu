import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { ChevronDown, RefreshCw, X } from '@/lib/icons'
import { notify } from '@/lib/notices'
import { openLink } from '@/lib/guguLinks'
import { useAuth } from '@/store/auth'
import { Collapse } from '@/components/ui/Collapse'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { importDeviceChoices } from '@renderer/features/session-import/import-device'
import { ImportSourceIcon, ImportSourceRows } from './ImportSourceRows'
import { importJobs, type ImportedEntry, type ImportJob } from './import-queue'
import './data-import.css'

function HistoryEntry({ job, onClose }: { job: ImportJob; onClose: () => void }) {
  const { t, i18n } = useTranslation('main')
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const date = new Date(job.finishedAt!)
  const timestamp = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }).format(date)
  const entries = job.result?.imported ?? []

  async function openSession(session: ImportedEntry) {
    try {
      if (job.provider.openImportedSession) {
        await job.provider.openImportedSession(session, session.deviceId)
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
        <ImportSourceIcon provider={job.provider} />
        <span className="gg-import-copy">
          <span className="gg-import-name">{job.provider.label}</span>
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

export const DataImportSection = observer(function DataImportSection({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('main')
  const { user } = useAuth()
  const [refresh, setRefresh] = useState(0)
  const jobs = useSyncExternalStore(importJobs.subscribe, importJobs.getSnapshot)
  const ownerJobs = jobs.filter(({ ownerId }) => ownerId === user?.id)
  useEffect(() => { remoteHostsStore.start() }, [])
  const machines = importDeviceChoices(t('settings.dataImport.thisComputer'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => device))
  const history = ownerJobs.filter((job) => job.finishedAt !== undefined && job.result && job.result.imported.length > 0)
    .sort((a, b) => b.finishedAt! - a.finishedAt!)

  return (
    <div className="gg-data-import">
      <IconButton shape="pill" size="lg" className="gg-import-close bg-foreground/[0.06]" aria-label={t('settings.close')} onClick={onClose}><X /></IconButton>
      <div className="gg-import-toolbar">
        <h2>{t('settings.nav.data-import')}</h2>
        <IconButton aria-label={t('settings.dataImport.refresh')} title={t('settings.dataImport.refresh')} onClick={() => setRefresh((n) => n + 1)}>
          <RefreshCw size={16} />
        </IconButton>
      </div>
      {user && <ImportSourceRows machines={machines} ownerId={user.id} jobs={ownerJobs} refresh={refresh} />}
      {history.length > 0 && (
        <section className="gg-import-history">
          <h3>{t('settings.dataImport.history')}</h3>
          <div className="gg-import-history-list">
            {history.map((job) => <HistoryEntry key={job.id} job={job} onClose={onClose} />)}
          </div>
        </section>
      )}
    </div>
  )
})
