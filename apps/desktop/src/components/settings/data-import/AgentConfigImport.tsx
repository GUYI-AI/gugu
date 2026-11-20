import { useEffect, useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { replica, useReplica } from '@/lib/replica'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { readAgentHome, readAgentHomeDiff } from '@renderer/features/settings/subscriptions/ensure-agent-home'
import { ReimportDialog } from '@renderer/features/settings/subscriptions/ReimportDialog'
import { AgentHomeSkippedFiles } from './AgentHomeSkippedFiles'
import type { AgentHomeDiff, AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'

const configHome = replica({
  name: 'configImportHome',
  scope: 'device',
  read: (_device: string, providerId: string) => readAgentHome(providerId, null),
})

export function AgentConfigImport({ providerId }: { providerId: string }) {
  const { t } = useTranslation('main')
  const titleId = useId()
  const reading = useReplica(configHome, [providerId])
  const preparing = reading.state === 'value' && Boolean(reading.value?.migrationPreparation)
  useEffect(() => {
    if (!preparing) return
    const timer = setInterval(() => { void configHome.refresh(providerId).catch(() => {}) }, 1000)
    return () => clearInterval(timer)
  }, [preparing, providerId])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [picked, setPicked] = useState<Set<string>>()
  const [issues, setIssues] = useState<AgentHomeScan['issues']>([])
  const [diff, setDiff] = useState<AgentHomeDiff | null>(null)
  if (reading.state === 'error') return <p role="status" className="gg-import-meta">{t('agentHome.migrationReadFailed')}</p>
  if (reading.state !== 'value' || !reading.value?.sourceReadable || preparing) return null
  const home = reading.value
  const groups = home.groups.filter(({ count }) => count > 0)
  if (home.needsImport && groups.length === 0) return null
  const groupIds = groups.filter(({ id }) => picked ? picked.has(id) : id !== 'hooks').map(({ id }) => id)

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (home.needsImport && groupIds.length === 0) return
    setBusy(true)
    setFailed(false)
    try {
      if (!home.needsImport) {
        setDiff(await readAgentHomeDiff(home.providerId, null))
        return
      }
      const client = await getAgentConfigRuntimeClient()
      const result = await client.importAgentHome({ providerId: home.providerId, groups: groupIds })
      if (!result.success) throw new Error('Could not import local configuration')
      setIssues(result.data.issues)
      await configHome.refresh(providerId)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  function finishReimport() {
    setDiff(null)
    void configHome.refresh(providerId).catch(() => setFailed(true))
  }

  return <section className="gg-import-history" data-testid={`${providerId}-config-import`}>
    <h3>{t('agentHome.local')}</h3>
    <form className="gg-import-history-entry p-3" onSubmit={(event) => void apply(event)}>
      <div className="gg-import-name">{home.name}</div>
      {home.needsImport && <fieldset className="my-2 space-y-2" disabled={busy} aria-label={t('agentHome.local')}>
        {groups.map(({ id }) => <label className="flex gap-2" key={id}>
          <input type="checkbox" value={id} checked={groupIds.includes(id)} onChange={(event) => {
            const next = new Set<string>(groupIds)
            if (event.target.checked) next.add(id)
            else next.delete(id)
            setPicked(next)
          }} />
          {t(`agentHome.groups.${id}`)}
        </label>)}
      </fieldset>}
      {failed && <p role="alert" className="gg-import-meta">{t('agentHome.configurationImportFailed')}</p>}
      <AgentHomeSkippedFiles issues={issues} />
      <Button type="submit" variant="secondary" size="sm" disabled={busy || (home.needsImport && groupIds.length === 0)}>
        {t(home.needsImport ? 'settings.dataImport.action' : 'agentHome.reimport')}
      </Button>
    </form>
    {diff && <Sheet onClose={() => setDiff(null)} titleId={titleId} desktopWidth="min(672px, 100%)"
      desktopMaxHeight="calc(100dvh - 32px)" dimNested zIndex="var(--z-settings-modal)">
      <ReimportDialog providerId={home.providerId} machine={null} diff={diff} titleId={titleId}
        onClose={() => setDiff(null)} onSuccess={finishReimport} />
    </Sheet>}
  </section>
}
