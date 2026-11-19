import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '../lib/log'
import { cleanupStepsText } from '../lib/cleanupStageCopy'
import { defaultResumeStore } from '../lib/agentProvision'
import { messageForUser } from '../lib/userFacingError'
import { publishUnfinishedAgentCreates, type UnfinishedAgentCreateView } from '../lib/unfinishedAgentCreateBridge'
import { continueUnfinishedSingleAgent, deleteUnfinishedSingleAgent, sweepUnfinishedSingleAgents } from '../lib/unfinishedSingleAgentSweep'
import { useAuth } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { useToast } from './toastContext'

const log = rendererLogger('agents/unfinished-create')
const rowsFor = (owner: string) => defaultResumeStore.list(owner).filter(record => record.blueprint.kind === 'single')
  .map(record => ({ operationId: record.operationId, name: record.blueprint.members[0].display_name }))

/** Only known completed creations finish on startup. Other work waits for the sidebar actions. */
export function UnfinishedAgentCreateSweeper({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation('agents')
  const { user } = useAuth()
  const { toast } = useToast()
  const { refreshChats } = useChatStore('refreshChats')
  const owner = active ? user?.id ?? null : null
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  const feedback = useRef({ t, toast, refreshChats })
  feedback.current = { t, toast, refreshChats }
  const running = useRef(false)
  const [view, setView] = useState<{ owner: string; rows: UnfinishedAgentCreateView['rows']; busy: boolean } | null>(null)

  useEffect(() => {
    if (!owner) { setView(null); return }
    let disposed = false
    try { setView({ owner, rows: rowsFor(owner), busy: false }) }
    catch (error) { feedback.current.toast(feedback.current.t('create.unfinished.readFailed'), 'error', messageForUser(error)); return }
    void sweepUnfinishedSingleAgents(owner).then(async outcomes => {
      if (disposed || currentOwner.current !== owner) return
      setView({ owner, rows: rowsFor(owner), busy: running.current })
      if (outcomes.some(item => item.kind === 'completed')) await feedback.current.refreshChats()
      for (const item of outcomes) if (item.kind === 'pending' && item.error) {
        log.error({ operationId: item.operationId, error: item.error }, 'creation status read failed; intent retained')
        feedback.current.toast(feedback.current.t('create.unfinished.readFailed'), 'error', messageForUser(item.error))
      }
    }).catch(error => {
      if (disposed || currentOwner.current !== owner) return
      setView(previous => previous?.owner === owner ? { ...previous, busy: false } : previous)
      feedback.current.toast(feedback.current.t('create.unfinished.readFailed'), 'error', messageForUser(error))
    })
    return () => { disposed = true }
  }, [owner])

  useEffect(() => {
    if (!owner || view?.owner !== owner) { publishUnfinishedAgentCreates(null); return }
    const run: UnfinishedAgentCreateView['run'] = (operationId, action) => {
      if (currentOwner.current !== owner || view.busy || running.current) return
      running.current = true
      setView(previous => previous?.owner === owner ? { ...previous, busy: true } : previous)
      const execute = action === 'continue' ? continueUnfinishedSingleAgent : deleteUnfinishedSingleAgent
      void execute(owner, operationId).then(async outcome => {
        if (currentOwner.current !== owner) return
        if (outcome.kind === 'completed') await refreshChats()
        else if (outcome.kind === 'pending') toast(t(action === 'continue' ? 'create.toast.stillStarting' : 'create.toast.cancelFailed'), 'error')
        else if (outcome.kind === 'cancelled' && outcome.warningStages.length) {
          toast(t('create.toast.cancelWarning', { steps: cleanupStepsText(outcome.warningStages, t, i18n.language) }), 'warning')
        }
      }).catch(error => {
        if (currentOwner.current === owner) toast(t(action === 'continue' ? 'create.toast.createFailed' : 'create.toast.cancelFailed'), 'error', messageForUser(error))
      }).finally(() => {
        running.current = false
        if (currentOwner.current === owner) {
          try { setView({ owner, rows: rowsFor(owner), busy: false }) }
          catch (error) {
            setView(previous => previous?.owner === owner ? { ...previous, busy: false } : previous)
            toast(t('create.unfinished.readFailed'), 'error', messageForUser(error))
          }
        }
      })
    }
    publishUnfinishedAgentCreates({ ownerUserId: owner, rows: view.rows, busy: view.busy, run })
    return () => publishUnfinishedAgentCreates(null)
  }, [owner, view, refreshChats, t, i18n.language, toast])
  return null
}
