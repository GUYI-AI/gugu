import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { FirstRunHarness as FirstRunHarnessId } from '@gugu/core/shared/firstRun'
import { invalidateAppSettingsKey } from '@renderer/features/settings/app-settings-client'
import { PREFERRED_SESSION_PROVIDERS } from '@shared/core/sessions/new-session-defaults'
import { AppIcon } from '@renderer/lib/components/app-icon'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Check } from '@/lib/icons'
import { writeFirstRunHarness } from '../../lib/firstRun'
import { useFirstRunInstaller } from './first-run-install-context'
import { useReplica } from '../../lib/replica'
import { Unknown } from '../ui/Unknown'
import { agentInstallationStatus } from '@renderer/lib/stores/agent-replicas'
import { localCopyOf, type LocalCopy } from './local-copy'
import './first-run-harness.css'

/** 多选推荐；本机已有且够新的副本直接用，没有或太旧才装咕咕托管的一份（见 FirstRunInstallProvider）。 */
export function FirstRunHarness({ userId, initial, onBack, onDone }: {
  userId: string
  /** 从下一页退回来时:上次选的(账号上记着的那份),❌ 又回到默认只勾 Codex。 */
  initial?: readonly string[] | null
  onBack?: () => void
  onDone: (selected: string[]) => void
}) {
  const { t } = useTranslation('main')
  const memory = useAppSettingsKey('newSessionMemory')
  const installInBackground = useFirstRunInstaller()
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(initial?.length ? initial : ['codex']))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = PREFERRED_SESSION_PROVIDERS.filter((id) => picked.has(id))
  const canContinue = selected.length > 0 && memory.settings.state === 'value' && !saving

  const toggle = (id: string) => setPicked((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const proceed = async () => {
    if (!canContinue) return
    setSaving(true)
    setError(null)
    try {
      await memory.updateAsync({ lastPicked: selected[0] })
      await writeFirstRunHarness(userId, selected)
      installInBackground(selected)
      onDone(selected)
    } catch (error) {
      rendererLogger('actions/FirstRunHarness').error({ error: error }, 'action failed')
      setError(messageForUser(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="ta-onb-title">{t('firstRun.harnessTitle')}</h1>
      <p className="ta-onb-sub">{t('firstRun.harnessSub')}</p>
      <div className="first-run-harness-choices" role="group" aria-label={t('firstRun.harnessTitle')}>
        {PREFERRED_SESSION_PROVIDERS.map((id) => (
          <HarnessChoice key={id} id={id}
            selected={picked.has(id)} disabled={saving} onToggle={() => toggle(id)} />
        ))}
      </div>
      {memory.settings.state === 'error' ? (
        <div role="alert">
          <p className="ta-onb-error">{t('firstRun.harnessReadFailed')}</p>
          <Button variant="secondary" size="sm" onClick={() => invalidateAppSettingsKey('newSessionMemory')}>{t('firstRun.retry')}</Button>
        </div>
      ) : null}
      {error ? <p className="ta-onb-error" role="alert">{error}</p> : null}
      <div className="ta-onb-actions first-run-harness-actions first-run-step-actions">
        {onBack ? <Button variant="ghost" size="lg" className="rounded-full" onClick={onBack} disabled={saving} data-testid="first-run-harness-back">{t('firstRun.back')}</Button> : null}
        <Button variant="primary" size="lg" className="rounded-full" disabled={!canContinue} onClick={() => void proceed()} data-testid="first-run-harness-continue">
          {saving ? t('firstRun.saving') : t('firstRun.continue')}
        </Button>
      </div>
    </>
  )
}

function HarnessChoice({ id, selected, disabled, onToggle }: {
  id: FirstRunHarnessId; selected: boolean; disabled: boolean; onToggle: () => void
}) {
  const { t } = useTranslation('main')
  const name = id === 'codex' ? 'Codex' : 'Claude'
  // This computer's shared installation status, as the agent store and Settings read it; Continue reads it again.
  const statuses = useReplica(agentInstallationStatus, [null])
  return (
    <label className="first-run-harness-choice" data-selected={selected} data-testid={`first-run-harness-${id}`}>
      <input type="checkbox" className="first-run-harness-input" checked={selected} disabled={disabled} onChange={onToggle}
        aria-label={t('firstRun.harnessSelect', { name })} />
      {id === 'codex' ? <Chip appearance="filled" className="first-run-harness-badge">{t('firstRun.harnessRecommended')}</Chip> : null}
      <span className="first-run-harness-check" aria-hidden>{selected ? <Check size={12} /> : null}</span>
      <AppIcon id={id} size={52} />
      <div className="first-run-harness-name">
        <h2>{name}</h2>
        <p data-testid={`first-run-harness-${id}-local`}>{statuses.state === 'value' ? localLine(t, id, localCopyOf(statuses.value.find((status) => status.id === id))) : statuses.state === 'error' ? messageForUser(statuses.error) : <Unknown />}</p>
      </div>
    </label>
  )
}

function localLine(t: TFunction<'main'>, id: string, local: LocalCopy): string {
  if (local.kind === 'usable') return t('firstRun.harnessLocalUsable', { version: local.version })
  if (local.kind === 'outdated') return t('firstRun.harnessLocalOutdated', { version: local.version })
  if (local.kind === 'broken') return t('firstRun.harnessLocalBroken', { command: id })
  return t('firstRun.harnessLocalMissing')
}
