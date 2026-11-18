import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import type { AgentHomeGroupId } from '@gugu/session-core/agents/plugins'
import { AppIcon } from '@renderer/lib/components/app-icon'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { Button } from '../ui/Button'
import { messageForUser } from '@/lib/userFacingError'
import { showModal } from '@renderer/lib/modal/modal-provider'
import './first-run-import.css'

/** Shared by onboarding, the upgrade gate and the per-harness session-start modal. */
export function FirstRunImport({ homes, machine = null, onBack, onDone }: {
  homes: AgentHomeScan[]
  machine?: string | null
  onBack?: () => void
  onDone: () => void
}) {
  const { t } = useTranslation('main')
  const [picked, setPicked] = useState(() => Object.fromEntries(homes.map((home) =>
    [home.providerId, new Set(home.groups.filter((group) => group.id !== 'hooks').map((group) => group.id))])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issues, setIssues] = useState<AgentHomeScan['issues'] | null>(null)
  const [notices, setNotices] = useState<{ providerId: string; name: string; terminal: boolean; skipped: number;
    relogin: { connectionId: string; name: string; methodId: string }[] }[]>([])
  const proceed = async (skip: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const client = await getAgentConfigRuntimeClient(machine)
      const skipped: AgentHomeScan['issues'] = []
      const notes: typeof notices = []
      for (const home of homes) {
        const result = await client.importAgentHome({ providerId: home.providerId, groups: skip ? [] : [...picked[home.providerId]!] })
        if (!result.success) throw new Error(result.error.type === 'unknown-provider' ? t('agentHome.failed') : result.error.message)
        skipped.push(...result.data.issues)
        if (result.data.terminalNeedsSignIn || result.data.relogin?.length || result.data.oldSessionsSkipped) notes.push({
          providerId: home.providerId, name: home.name, terminal: !!result.data.terminalNeedsSignIn,
          relogin: result.data.relogin ?? [], skipped: result.data.oldSessionsSkipped ?? 0,
        })
      }
      const warnings = skipped.filter((issue) => !['sensitive', 'database'].includes(issue.reason))
      if (warnings.length || notes.length) { setIssues(warnings); setNotices(notes) }
      else onDone()
    } catch (error) { setError(messageForUser(error)) }
    finally { setBusy(false) }
  }
  const toggle = (providerId: string, id: AgentHomeGroupId) => setPicked((current) => {
    const next = new Set(current[providerId])
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return { ...current, [providerId]: next }
  })
  return <>
    <h1 className="ta-onb-title">{t('agentHome.title')}</h1>
    <p className="ta-onb-sub">{t('agentHome.intro')}</p>
    <div className="agent-home-cards">
      {homes.map((home) => <section key={home.providerId} className="agent-home-card" data-testid={`agent-home-card-${home.providerId}`}>
        <header><AppIcon id={home.providerId} size={28} /><div><strong>{home.name}</strong><p>{home.userRoot}</p></div></header>
        <div className="agent-home-groups">
          {home.groups.map((group) => <label key={group.id}>
            <input type="checkbox" checked={picked[home.providerId]!.has(group.id)} disabled={busy || !!issues}
              onChange={() => toggle(home.providerId, group.id)} data-testid={`agent-home-group-${home.providerId}-${group.id}`} />
            {t(`agentHome.groups.${group.id}`)} <span>{group.count}</span>
            {group.id !== 'mcp' && !!group.mcpCount && <small>{t('agentHome.mcpCount', { count: group.mcpCount })}</small>}
          </label>)}
        </div>
        {home.mcpSecrets.length > 0 && <p className="agent-home-note">{t('agentHome.mcpSecrets', { names: home.mcpSecrets.join(', ') })}</p>}
        {home.projectMcpCount > 0 && <p className="agent-home-note">{t('agentHome.projectMcp', { count: home.projectMcpCount })}</p>}
        <p className="agent-home-signin">{t('agentHome.signIn')}</p>
        {home.migration && <p className="agent-home-note">{t('agentHome.migration')}</p>}
        {!!home.unmarkedMcp?.length && <p className="agent-home-note"><input type="checkbox" disabled checked={false} readOnly /> {t('agentHome.unmarkedMcp', { names: home.unmarkedMcp.join(', ') })}</p>}
        {home.issues.filter((issue) => !['sensitive', 'database'].includes(issue.reason)).map((issue) =>
          <p className="agent-home-note" key={issue.path}>{issue.path} · {t(`agentHome.issue.${issue.reason}`)}</p>)}
      </section>)}
    </div>
    <p className="agent-home-note">{t('agentHome.copyNote')}</p>
    {error && <p className="ta-onb-error" role="alert">{error}</p>}
    {issues && <div role="status">{issues.map((issue) => <p className="agent-home-note" key={issue.path}>
      {issue.path} · {t(`agentHome.issue.${issue.reason}`)}
    </p>)}</div>}
    {notices.map((note) => <div key={note.providerId} role="status">
      {note.terminal && <p>{t('agentHome.terminalSignIn', { name: note.name })}</p>}
      {!!note.skipped && <p>{t('agentHome.oldSessionsSkipped', { count: note.skipped })}</p>}
      {note.relogin.map((account) => <p key={account.connectionId}>{t('agentHome.accountSignIn', { name: account.name })} <Button variant="secondary" onClick={() => showModal('agentSignInModal', {
        providerId: note.providerId, providerName: note.name, connectionId: account.connectionId, steps: [{ methodId: account.methodId }],
        ...(machine ? { remote: { deviceId: machine, deviceLabel: machine, headless: true, command: note.providerId } } : {}),
        onSuccess: () => { void (async () => {
          try {
            const result = await (await getAgentConfigRuntimeClient(machine)).selectConnection({ providerId: note.providerId, connectionId: account.connectionId })
            if (!result.success) throw new Error('message' in result.error ? result.error.message : t('agentHome.failed'))
            setNotices((current) => current.map((row) => row.providerId === note.providerId ? { ...row, relogin: row.relogin.filter((entry) => entry.connectionId !== account.connectionId) } : row))
          } catch (error) { setError(messageForUser(error)) }
        })() },
      })}>{t('agentHome.signInAction')}</Button></p>)}
    </div>)}
    <div className="ta-onb-actions first-run-step-actions agent-home-actions">
      {onBack && <Button variant="ghost" size="lg" onClick={onBack} disabled={busy}>{t('firstRun.back')}</Button>}
      {issues ? <Button variant="primary" size="lg" onClick={onDone}>{t('firstRun.continue')}</Button> : <>
        <Button variant="ghost" size="lg" onClick={() => void proceed(true)} disabled={busy} data-testid="first-run-import-skip">{t('agentHome.skip')}</Button>
        <Button variant="primary" size="lg" onClick={() => void proceed(false)} disabled={busy} data-testid="first-run-import-continue">{t(busy ? 'firstRun.saving' : 'agentHome.importContinue')}</Button>
      </>}
    </div>
  </>
}
