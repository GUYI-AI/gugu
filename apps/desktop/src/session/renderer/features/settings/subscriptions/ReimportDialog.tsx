import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentHomeDiff } from '@gugu/session-core/workspace-server/agent-config'
import { Button } from '@/components/ui/Button'
import { messageForUser } from '@/lib/userFacingError'
import { DialogContentArea, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { errorText } from './subscription-queries'

export function ReimportDialog({ providerId, machine, diff, onClose, onSuccess }: {
  providerId: string; machine: string | null; diff: AgentHomeDiff; onClose: () => void; onSuccess: () => void
}) {
  const { t } = useTranslation('main')
  const [picked, setPicked] = useState(() => new Set(diff.entries.filter((entry) => ['userChanged', 'userAdded'].includes(entry.state)).map((entry) => entry.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const apply = async () => {
    setBusy(true); setError(null)
    try {
      const client = await getAgentConfigRuntimeClient(machine)
      const result = await client.reimportAgentHome({ providerId, decisions: diff.entries.filter((entry) => picked.has(entry.id)).map(({ id, revision }) => ({ id, revision })) })
      if (!result.success) throw new Error(errorText(result.error))
      if (result.data.issues.some((issue) => !['sensitive', 'database'].includes(issue.reason))) {
        throw new Error(result.data.issues.filter((issue) => !['sensitive', 'database'].includes(issue.reason))
          .map((issue) => `${issue.path}: ${t(`agentHome.issue.${issue.reason}`)}`).join('\n'))
      }
      onSuccess()
    } catch (error) { setError(messageForUser(error)) }
    finally { setBusy(false) }
  }
  return <div data-testid="agent-home-reimport-dialog">
      <DialogHeader><DialogTitle>{t('agentHome.reimportTitle')}</DialogTitle></DialogHeader>
      <DialogContentArea>
        {[...new Set(diff.entries.map((entry) => entry.group))].map((group) => <fieldset key={group} className="mb-4">
          <legend className="mb-2 font-medium"><label className="flex gap-2"><input type="checkbox" disabled={busy}
            checked={diff.entries.filter((entry) => entry.group === group && ['userChanged', 'userAdded', 'bothChanged'].includes(entry.state)).every((entry) => picked.has(entry.id))}
            onChange={(event) => { const checked = event.currentTarget.checked; setPicked((current) => {
              const next = new Set(current)
              for (const entry of diff.entries.filter((entry) => entry.group === group && ['userChanged', 'userAdded', 'bothChanged'].includes(entry.state))) {
                if (checked) next.add(entry.id); else next.delete(entry.id)
              }
              return next
            }) }} />{t(`agentHome.groups.${group}`)}</label></legend>
          {diff.entries.filter((entry) => entry.group === group).map((entry) => {
            const selectable = ['userChanged', 'userAdded', 'bothChanged'].includes(entry.state)
            return <label key={entry.id} className={`flex items-start gap-2 py-2 ${entry.state === 'unchanged' ? 'opacity-50' : ''}`}>
              <input type="checkbox" disabled={busy || !selectable} checked={picked.has(entry.id)} onChange={() => setPicked((current) => {
                const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next
              })} />
              <span><span className="block break-all">{entry.path}</span><span className="text-foreground-muted">
                {entry.uncertain ? t('agentHome.uncertain') : t(`agentHome.states.${entry.state}`)}
              </span></span>
            </label>
          })}
        </fieldset>)}
        <p className="text-foreground-muted">{t('agentHome.loginNotSynced')}</p>
        {diff.issues.filter((issue) => !['sensitive', 'database'].includes(issue.reason)).map((issue) => <p key={issue.path} className="text-foreground-muted">{issue.path} · {t(`agentHome.issue.${issue.reason}`)}</p>)}
        {error && <p role="alert" className="text-destructive whitespace-pre-wrap">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('agentHome.cancel')}</Button>
          <Button variant="primary" onClick={() => void apply()} disabled={busy} data-testid="agent-home-reimport-apply">{t('agentHome.apply')}</Button>
        </div>
      </DialogContentArea>
  </div>
}
