import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '../lib/log'
import { cleanupStepsText } from '../lib/cleanupStageCopy'
import { messageForUser } from '../lib/userFacingError'
import { publishUnfinishedAgentCreates, type UnfinishedAgentCreateView } from '../lib/unfinishedAgentCreateBridge'
import { readUnfinishedAgentRows, unfinishedAgentCreateRows } from '../lib/unfinishedAgentCreateRows'
import { replicaAccount, useReplica } from '../lib/replica'
import { continueUnfinishedSingleAgent, deleteUnfinishedSingleAgent, sweepUnfinishedSingleAgents } from '../lib/unfinishedSingleAgentSweep'
import { useAuth } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { useToast } from './toastContext'

const log = rendererLogger('agents/unfinished-create')

/** The account replica owns display data; the bridge owns this interaction's busy state and callbacks. */
export function UnfinishedAgentCreateSweeper({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation('agents')
  const { user } = useAuth()
  const { toast } = useToast()
  const { refreshChats } = useChatStore('refreshChats')
  const owner = active ? user?.id ?? null : null
  useReplica(unfinishedAgentCreateRows, owner ? [] : null, { read: false })
  const replicaOwner = replicaAccount().id
  const feedback = useRef({ t, toast, refreshChats, language: i18n.language })
  feedback.current = { t, toast, refreshChats, language: i18n.language }

  useEffect(() => {
    if (!owner || replicaOwner !== owner) { publishUnfinishedAgentCreates(null); return }
    const target = unfinishedAgentCreateRows.at()
    let current = true
    let running = false
    const report = (key: string, error: unknown) => {
      if (current) feedback.current.toast(feedback.current.t(key), 'error', messageForUser(error))
    }
    const publish = () => publishUnfinishedAgentCreates({ ownerUserId: owner, busy: running, run })
    const updateRows = () => target.set(readUnfinishedAgentRows(owner))
    const run: UnfinishedAgentCreateView['run'] = (operationId, action) => {
      if (!current || running) return
      running = true
      publish()
      const execute = action === 'continue' ? continueUnfinishedSingleAgent : deleteUnfinishedSingleAgent
      void execute(owner, operationId).then(async outcome => {
        if (!current) return
        const { t, toast, refreshChats, language } = feedback.current
        if (outcome.kind === 'completed') await refreshChats()
        else if (outcome.kind === 'pending') toast(t(action === 'continue' ? 'create.toast.stillStarting' : 'create.toast.cancelFailed'), 'error')
        else if (outcome.kind === 'cancelled' && outcome.warningStages.length) {
          toast(t('create.toast.cancelWarning', { steps: cleanupStepsText(outcome.warningStages, t, language) }), 'warning')
        }
      }).catch(error => report(action === 'continue' ? 'create.toast.createFailed' : 'create.toast.cancelFailed', error)).finally(() => {
        if (!current) return
        running = false
        try { updateRows() } catch (error) { report('create.unfinished.readFailed', error) }
        publish()
      })
    }
    try { updateRows() } catch (error) { report('create.unfinished.readFailed', error) }
    publish()
    void sweepUnfinishedSingleAgents(owner).then(async outcomes => {
      if (!current) return
      updateRows()
      if (outcomes.some(item => item.kind === 'completed')) await feedback.current.refreshChats()
      for (const item of outcomes) if (item.kind === 'pending' && item.error && current) {
        log.error({ operationId: item.operationId, error: item.error }, 'creation status read failed; intent retained')
        report('create.unfinished.readFailed', item.error)
      }
    }).catch(error => report('create.unfinished.readFailed', error))
    return () => { current = false; publishUnfinishedAgentCreates(null) }
  }, [owner, replicaOwner])
  return null
}
