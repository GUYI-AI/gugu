// #7350 关闭咕咕的确认框只有一个(product spec「关闭咕咕」):设置里的「关闭咕咕」、通讯录 / agent 设置里删它,
// 都只发 `requestAssistantClose()`,这里按它住哪画对应的那一份 —— ❌ 走通讯录那条「删除 Agent」的通用确认(它一个字不提记忆和家)。
//   - 住这台电脑上:清它的记忆、性格、文件、定时任务;它开过的会话删不删由人勾(默认留)。步骤见 lib/assistantClose。
//   - 住云上:同一份确认、同一套关闭步骤；管家只清助理资料，宿主和保留的会话不删除。
//   - 住别的电脑上:它的家和定时任务都在那台,这里关不干净 —— 照实说去那台关。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rpcOn } from '@renderer/lib/ipc'
import { moveJournalStore } from '@renderer/features/assistant/assistant-move-wire'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { cn } from '../../lib/cn'
import { notify } from '../../lib/notices'
import { listDevicesOnceIdentified } from '../../lib/listDevicesOnceIdentified'
import { wakeCloudComputerUntilOnline } from '@gugu/core/cloud/cloudComputer'
import { rendererCloudComputerClient } from '../../lib/cloudComputerClient'
import { useAssistantHome } from '../../lib/useAssistantHome'
import { refreshMyAssistant } from '../../lib/myAssistant'
import { assistantResumeStore } from '../../lib/assistantSetup'
import { retireCustomizeCard, writeSetupStep } from '../../lib/assistantSetupState'
import { ASSISTANT_HOME_CHANNELS } from '../../lib/assistantHomeIpc'
import {
  AssistantCloseError,
  closeLocalAssistant,
  planLocalClose,
  type LocalCloseDeps,
  type LocalClosePlan,
} from '../../lib/assistantClose'
import { UI_EVENTS } from '../../lib/uiEvents'
import { rendererLogger } from '../../lib/log'
import { desktopIpc } from '../../platform/desktopIpc'
import { machineRpc } from '../../mobile/agent-watch/sessionpage-rpc'
import { clearServerAssistantSetup } from '../../lib/assistantServerSetup'
import { replica, useReplica } from '../../lib/replica'
import { useAuth } from '../../store/auth'
import { useContactsStore } from '../../store/contactsContext'
import { useDevicesStore } from '../../store/devicesContext'
import '../../i18n/registerAssistantCatalog'

const log = rendererLogger('assistant/close')
const text = 'text-[length:var(--font-body)] leading-[1.5]'

type Home = { kind: 'local' } | { kind: 'cloud'; deviceId: string } | { kind: 'server'; deviceId: string }
type Open = { assistantId: string; name: string } & (Home | { kind: 'elsewhere'; device: string })

const sessionsHost = (kind: Home['kind'], deviceId: string | null) => kind === 'server' && deviceId ? machineRpc(deviceId) : rpcOn(kind === 'cloud' ? deviceId : null)
const listHomeSessions = async (kind: Home['kind'], deviceId: string | null) => (await sessionsHost(kind, deviceId).sessionTimeline.sessionsList()).sessions

/** The sessions the close confirmation shows, read once the home is woken and checked; the confirm closes exactly this plan. */
const assistantClosePlan = replica({
  name: 'assistantClosePlan',
  scope: 'account',
  keep: 0,
  read: async (_owner: string, assistantId: string, kind: Home['kind'], deviceId: string | null): Promise<LocalClosePlan> => {
    try {
      return planLocalClose(assistantId, await listHomeSessions(kind, deviceId))
    } catch (error) {
      log.warn({ error: String(error) }, 'list sessions for closing the assistant failed')
      throw error
    }
  },
})

export function AssistantCloseHost() {
  const { t } = useTranslation('assistant')
  const { user } = useAuth()
  const ownerUserId = user?.id ?? null
  const { contact, home } = useAssistantHome()
  const { removeOwnedAgent } = useContactsStore()
  const { refresh } = useDevicesStore()
  const [open, setOpen] = useState<Open | null>(null)

  useEffect(() => {
    const onRequest = () => {
      if (!contact || !home) {
        log.warn({ hasContact: !!contact, hasHome: !!home }, 'close requested but the assistant or its home is not known')
        return
      }
      const who = { assistantId: contact.id, name: contact.display_name }
      if (home.kind === 'cloud') {
        setOpen({ ...who, kind: 'cloud', deviceId: home.deviceId })
        return
      }
      if (home.hostKind === 'server') setOpen({ ...who, kind: 'server', deviceId: home.deviceId })
      else if (home.thisDevice) setOpen({ ...who, kind: 'local' })
      else setOpen({ ...who, kind: 'elsewhere', device: home.label ?? t('home.thatComputer') })
    }
    window.addEventListener(UI_EVENTS.closeAssistant, onRequest)
    return () => window.removeEventListener(UI_EVENTS.closeAssistant, onRequest)
  }, [contact, home, t])

  const localDeps = useMemo<LocalCloseDeps | null>(() => {
    if (!ownerUserId) return null
    const cloud = open?.kind === 'cloud' ? open : null
    const server = open?.kind === 'server' ? open : null
    const target = server?.deviceId ?? cloud?.deviceId ?? null
    const kind: Home['kind'] = server ? 'server' : cloud ? 'cloud' : 'local'
    const remote = () => sessionsHost(kind, target)
    const checkCloud = async () => {
      if (server) {
        const row = (await listDevicesOnceIdentified()).find(device => device.device_id === server.deviceId)
        if (!row?.is_online || row.capabilities.assistant_home_setup !== 1) throw new Error('assistant server is offline or needs updating')
        const checked = await machineRpc(server.deviceId).assistantHome.checkClose({ ownerUserId, deviceId: server.deviceId, assistantId: server.assistantId })
        if (!checked.ok) throw new Error(`assistant server close check failed: ${checked.error.code}`)
        return
      }
      if (!cloud) return
      const client = rendererCloudComputerClient()
      if (!client) throw new Error('cloud computer is not configured')
      const result = await wakeCloudComputerUntilOnline({ client, deviceId: cloud.deviceId, purpose: 'close', isOnline: async (id) => (await listDevicesOnceIdentified()).some((device) => device.device_id === id && device.is_online) })
      if (result !== 'online') throw new Error('the cloud home changed before close')
      await client.prepareAssistantClose({ deviceId: cloud.deviceId, assistantId: cloud.assistantId })
    }
    return {
      check: checkCloud,
      listSessions: () => listHomeSessions(kind, target),
      listAutomations: () => remote().automations.listAutomations(),
      deleteAutomation: (id) => remote().automations.deleteAutomation(id),
      removeAgent: (agentUserId) => removeOwnedAgent(agentUserId),
      archiveSession: async (projectId, sessionId) => {
        const outcome = await remote().sessions.archiveSession(projectId, sessionId, { withChildren: false, removeSocialIdentity: false })
        if (outcome.unreached.length > 0) throw new Error(`archive did not reach ${outcome.unreached.length} machine(s)`)
      },
      wipeHome: async () => {
        if (server) {
          const result = await machineRpc(server.deviceId).assistantHome.wipe({ ownerUserId, deviceId: server.deviceId, assistantId: server.assistantId })
          if (!result.ok) throw new Error(`assistant server cleanup failed: ${result.error.code}`)
          return
        }
        if (cloud) {
          const client = rendererCloudComputerClient()
          if (!client) throw new Error('cloud computer is not configured')
          await client.closeAssistant({ deviceId: cloud.deviceId, assistantId: cloud.assistantId })
          await refresh()
          return
        }
        const ipc = desktopIpc()
        if (!ipc) throw new Error('only the desktop app can clear its home')
        await ipc.invoke(ASSISTANT_HOME_CHANNELS.wipe)
      },
      resetLocalState: () => {
        writeSetupStep(ownerUserId, null)
        clearServerAssistantSetup(ownerUserId)
        retireCustomizeCard(ownerUserId)
        for (const record of assistantResumeStore.list(ownerUserId)) assistantResumeStore.forget(ownerUserId, record.operationId)
        moveJournalStore(ownerUserId).clear()
        void refreshMyAssistant()
      },
    }
  }, [ownerUserId, removeOwnedAgent, open, refresh])

  const close = useCallback(() => setOpen(null), [])
  if (!open) return null
  const name = open.name

  if (open.kind === 'elsewhere') {
    return (
      <Sheet onClose={close} desktopWidth="400px" mobileFitContent ariaLabel={t('closeDialog.elsewhereTitle')} testId="assistant-close-elsewhere" zIndex="var(--z-settings-modal)">
        <div className="flex flex-col gap-3 p-[18px]">
          <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('closeDialog.elsewhereTitle')}</div>
          <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('closeDialog.elsewhereBody', { name, device: open.device })}</div>
          <div className="flex justify-end">
            <Button size="sm" onClick={close}>{t('closeDialog.elsewhereOk')}</Button>
          </div>
        </div>
      </Sheet>
    )
  }

  if (!localDeps) return null
  return <LocalCloseDialog assistantId={open.assistantId} name={name} home={open.kind === 'local' ? [open.kind, null] : [open.kind, open.deviceId]} deps={localDeps} onClose={close} />
}

function LocalCloseDialog({ assistantId, name, home, deps, onClose }: {
  assistantId: string; name: string; home: [Home['kind'], string | null]; deps: LocalCloseDeps; onClose: () => void
}) {
  const { t } = useTranslation('assistant')
  const [woken, setWoken] = useState<'checking' | 'ready' | 'failed'>('checking')
  const [deleteStarted, setDeleteStarted] = useState(false)
  const [closing, setClosing] = useState(false)
  const [failure, setFailure] = useState<AssistantCloseError | null>(null)

  // @@@effect-flow(command) - the close preflight wakes / checks the home once per opened dialog (a cloud computer is woken until online); state holds only whether that check passed, the sessions are the assistantClosePlan reading
  useEffect(() => {
    let cancelled = false
    setWoken('checking')
    Promise.resolve(deps.check?.()).then(
      () => { if (!cancelled) setWoken('ready') },
      (error: unknown) => {
        log.warn({ error: String(error) }, 'checking the assistant home before closing failed')
        if (!cancelled) setWoken('failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [deps])
  const reading = useReplica(assistantClosePlan, woken === 'ready' ? [assistantId, ...home] : null)
  // 读不到它开过哪些会话 = 不知道那个勾在说什么、也不知道它自己的会话在哪:❌ 照着空清单关。
  const unreadable = woken === 'failed' || reading.state === 'error'

  const confirm = async (plan: LocalClosePlan) => {
    setClosing(true)
    setFailure(null)
    try {
      await closeLocalAssistant({ assistantId, deleteStarted }, plan, deps)
      notify({ title: t('closeDialog.closed'), tier: 'success' })
      onClose()
    } catch (error) {
      const known = error instanceof AssistantCloseError ? error : new AssistantCloseError('home', 'failed', error)
      log.error({ step: known.step, kind: known.kind, error: String((known.reason as Error)?.message ?? known.reason) }, 'close local assistant failed')
      setFailure(known)
      setClosing(false)
    }
  }

  const plan = reading.state === 'value' ? reading.value : null
  return (
    <Sheet
      onClose={closing ? () => undefined : onClose}
      desktopWidth="400px"
      desktopMaxHeight="80vh"
      mobileFitContent
      ariaLabel={t('closeDialog.title', { name })}
      testId="assistant-close-dialog"
      zIndex="var(--z-settings-modal)"
    >
      <div className="flex flex-col gap-3 overflow-y-auto p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('closeDialog.title', { name })}</div>
        <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('closeDialog.body')}</div>
        {!plan && !unreadable && <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('closeDialog.checking')}</div>}
        {unreadable && <div className={cn(text, 'text-[var(--danger-fg)]')} role="alert">{t('closeDialog.unreadable')}</div>}
        {plan && plan.started.length > 0 && (
          <div className="flex flex-col gap-2">
            <label className={cn(text, 'flex cursor-pointer items-start gap-2 text-[var(--fg)]')}>
              <input
                type="checkbox"
                checked={deleteStarted}
                disabled={closing}
                onChange={(e) => setDeleteStarted(e.target.checked)}
                className="mt-[2px]"
                data-testid="assistant-close-delete-started"
              />
              <span>{t('closeDialog.deleteStarted', { count: plan.started.length })}</span>
            </label>
            <div className="flex max-h-40 flex-col gap-[5px] overflow-y-auto rounded-[var(--radius-document)] bg-foreground/[0.025] px-[10px] py-2 dark:bg-foreground/[0.04]">
              {plan.started.map((session) => (
                <div key={session.conversationId} className={cn(text, 'truncate text-[var(--fg)]')}>{session.title}</div>
              ))}
            </div>
            {!deleteStarted && <div className={cn(text, 'text-[var(--muted-fg)]')}>{t('closeDialog.keepStartedNote')}</div>}
          </div>
        )}
        {failure && (
          <div className={cn(text, 'text-[var(--danger-fg)]')} role="alert" data-testid="assistant-close-failure">
            {failure.kind === 'schedule-starting' ? t('closeDialog.scheduleStarting') : t(`closeDialog.failedAt.${failure.step}`)}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onClose} disabled={closing}>{t('closeDialog.cancel')}</Button>
          <Button size="sm" variant="danger" disabled={closing || !plan} onClick={() => { if (plan) void confirm(plan) }} data-testid="assistant-close-confirm">
            {closing ? t('closeDialog.closing') : t('closeDialog.confirm')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
