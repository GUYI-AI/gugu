import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import '@/i18n/registerMessagingCatalog'
import type { UnavailableProject } from '@/session/shared/projects'
import { archiveUnavailableProjects, projectRecoveryMessage, readUnavailableProjects, recoverUnavailableProject } from '@/lib/projectRecovery'
import { readArchivedGroups } from '@/lib/archivedGroupsRead'
import { platform } from '@/platform'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Sheet } from '../ui/Sheet'
import './projectRecovery.css'

/** The status and its two explicit actions occupy the existing second line. */
export function ProjectRecoverySubtitle({ project }: { project: UnavailableProject }) {
  const { t } = useTranslation('messaging')
  const [confirmed, setConfirmed] = useState<UnavailableProject[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const recover = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const path = await platform.selectDirectory()
      if (path) await recoverUnavailableProject(project, path)
    } catch (failure) { setError(projectRecoveryMessage(failure)) }
    finally { setBusy(false) }
  }
  const askToClean = async () => {
    setError('')
    let rows: UnavailableProject[]
    try { rows = await readUnavailableProjects() } catch { setError(t('projectRecovery.checkFailed')); return }
    const projects = rows.filter(row => row.chatId && !readArchivedGroups().has(row.chatId))
    if (projects.length) setConfirmed(projects)
  }
  const clean = async () => {
    if (!confirmed || busy) return
    setBusy(true); setError('')
    try { await archiveUnavailableProjects(confirmed); setConfirmed(null) }
    catch (failure) {
      setError(projectRecoveryMessage(failure))
      setConfirmed(rows => rows?.filter(row => !row.chatId || !readArchivedGroups().has(row.chatId)) ?? null)
    }
    finally { setBusy(false) }
  }
  return <>
    <span className="gg-project-unavailable-status"><Chip>{t('projectRecovery.unavailable')}</Chip>{' '}{t('projectRecovery.folderMissing')}</span>
    <span className="gg-project-recovery-actions" onClick={event => event.stopPropagation()}>
      <Button size="sm" disabled={busy} onClick={() => void recover()}>{t('projectRecovery.restore')}</Button>
      <Button size="sm" disabled={busy || !project.chatId} onClick={() => void askToClean()}>{t('projectRecovery.clean')}</Button>
    </span>
    {error && !confirmed && <span role="alert" className="gg-project-recovery-error">{error}</span>}
    {confirmed && <Sheet onClose={() => { if (!busy) setConfirmed(null) }} desktopWidth="380px" ariaLabel={t('projectRecovery.cleanLabel')} testId="project-cleanup-confirm">
      <div className="flex flex-col gap-4 p-6" onClick={event => event.stopPropagation()}>
        <h2 className="font-semibold text-[length:var(--font-title)]">{t('projectRecovery.cleanTitle', { count: confirmed.length })}</h2>
        <ul className="flex max-h-64 flex-col gap-3 overflow-y-auto">
          {confirmed.map(row => <li key={row.id} className="flex items-center gap-3"><Avatar variant="group" name={row.name} seed={row.chatId ?? row.id} size={28} /><span>{row.name}</span></li>)}
        </ul>
        <p className="text-[var(--muted-fg)]">{t('projectRecovery.cleanBody')}</p>
        {error && <p role="alert" className="text-[var(--danger)]">{error}</p>}
        <div className="flex justify-end gap-2"><Button size="sm" disabled={busy} onClick={() => setConfirmed(null)}>{t('projectRecovery.cancel')}</Button><Button variant="primary" size="sm" disabled={busy} onClick={() => void clean()}>{t('projectRecovery.clean')}</Button></div>
      </div>
    </Sheet>}
  </>
}
