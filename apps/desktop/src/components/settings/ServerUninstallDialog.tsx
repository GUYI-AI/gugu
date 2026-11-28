import { messageForUser } from '@/lib/userFacingError'
import { archiveOwnedAgent } from '@/lib/archiveOwnedAgent'
import { rpcOn } from '@renderer/lib/ipc'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import type { DevicesContextValue } from '../../store/devicesContext'
import {
  SERVER_SSH_MACHINES_CHANNELS,
  type ServerUninstallStartResponse,
  type ServerUninstallState,
} from '../../lib/serverSshMachines'
import { rendererLogger } from '../../lib/log'
import { desktopIpc } from '../../platform/desktopIpc'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { SshPromptCard } from './addServer/SshPromptCard'

// #6264「从这台机器上卸载咕咕 server」(只给这台电脑用 SSH 装上的机器)。
// 经 SSH 连过去停服务、删安装。
// 两段式:先连上去看清楚装了什么、谁登着,摆在确认页上(卸载会让同机的其他账号一起用不了,要点名);
// 人确认后归档宿主的任务，再卸载。账号数据原位保留供重装使用。

const api = desktopIpc
const log = rendererLogger('devices')

const body = 'text-[length:var(--font-body)] leading-[1.5]'
const muted = 'text-[var(--muted-fg)]'

/** 失败原因 → 一句人话。SSH 那几种与「添加一台机器」同一套说法。 */
function reasonKey(reason: NonNullable<ServerUninstallState['failure']>['reason']): string {
  return reason === 'uninstallFailed' || reason === 'revokeFailed' || reason === 'updateRequired' ? `devices.uninstall.${reason}` : `devices.addServer.reasons.${reason}`
}

async function archiveServerTasks(deviceId: string, listBoundAgents: DevicesContextValue['listBoundAgents']): Promise<void> {
  const host = rpcOn(deviceId)
  const agents = await listBoundAgents(deviceId)
  for (const agent of agents) await archiveOwnedAgent(agent.id, { removeSocialIdentity: true })
  // The host still knows its active tasks when identity archival committed but the host action did not.
  for (const task of await host.sessions.getSessions()) {
    const outcome = await host.sessions.archiveSession(task.projectId, task.id, { removeSocialIdentity: true })
    if (outcome.unreached.length) throw new Error('The task host could not be reached')
  }
  if ((await listBoundAgents(deviceId)).length) throw new Error('Some agents still need to be archived')
}

export function ServerUninstallDialog({
  device,
  address,
  listBoundAgents,
  onRemove,
  onRemoveOnly,
  onClose,
}: {
  device: Device
  address: string
  listBoundAgents: DevicesContextValue['listBoundAgents']
  /** Remove the empty device after archive and uninstall. */
  onRemove: () => Promise<void>
  /** 连不上 / 已经没装:改走「只移除」。 */
  onRemoveOnly: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('settings')
  const [runId, setRunId] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, ServerUninstallState>>({})
  const [unknownMachine, setUnknownMachine] = useState(false)
  const [removed, setRemoved] = useState<true | string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [agentCount, setAgentCount] = useState<number | null>(null)
  const [countError, setCountError] = useState(false)
  const runIdRef = useRef<string | null>(null)
  const removeStarted = useRef(false)

  useEffect(() => {
    const electron = api()
    if (!electron) return
    let live = true
    // 状态可能先于 start 的返回值到达:按 runId 全收着,展示时再按当前这次取。
    const off = electron.eventOn(SERVER_SSH_MACHINES_CHANNELS.uninstallState, (value) => {
      const state = value as ServerUninstallState
      if (state?.runId) setStates((prev) => ({ ...prev, [state.runId]: state }))
    })
    void (electron.invoke(SERVER_SSH_MACHINES_CHANNELS.uninstallStart, { deviceId: device.device_id }) as Promise<ServerUninstallStartResponse>).then(
      (response) => {
        if (!live) return
        if ('error' in response) {
          setUnknownMachine(true)
          return
        }
        runIdRef.current = response.runId
        setStates((prev) => ({ [response.runId]: prev[response.runId] ?? response.state }))
        setRunId(response.runId)
      },
      (error: unknown) => {
        log.error({ err: String((error as Error)?.message ?? error) }, 'uninstall start failed')
        if (live) setUnknownMachine(true)
      },
    )
    return () => {
      live = false
      off()
      // 关掉窗口时还没开始删 ⇒ 当作不卸了,❌ 让它在看不见的地方继续问密码。
      const id = runIdRef.current
      if (id) void api()?.invoke(SERVER_SSH_MACHINES_CHANNELS.uninstallCancel, id)
    }
  }, [device.device_id, attempt])

  const state = runId ? states[runId] ?? null : null
  const phase = state?.phase ?? (unknownMachine ? null : 'inspecting')

  useEffect(() => {
    if (state?.failure) log.error({ reason: state.failure.reason, detail: state.failure.detail ?? null, target: state.target }, 'server uninstall failed')
  }, [state?.failure, state?.target])

  const inspection = state?.inspection ?? null
  const othersSignedIn = inspection?.accounts.some((account) => !account.you && account.signedIn) ?? false
  const needsSignIn = Boolean(inspection && !inspection.archiveReady && inspection.accounts.length > 0
    && !inspection.accounts.some((account) => account.you && account.signedIn))

  useEffect(() => {
    if (phase !== 'confirm' || !inspection?.installed) return
    let live = true
    void listBoundAgents(device.device_id).then(
      (agents) => { if (live) setAgentCount(agents.length) },
      () => { if (live) setCountError(true) },
    )
    return () => { live = false }
  }, [phase, inspection?.installed, device.device_id, listBoundAgents])

  useEffect(() => {
    if (phase !== 'done' || removeStarted.current) return
    removeStarted.current = true
    void onRemove().then(() => setRemoved(true), (error: unknown) => setRemoved(messageForUser(error)))
  }, [phase, onRemove])

  const answer = useCallback((value: string | null) => {
    if (!state?.prompt) return
    void api()?.invoke(SERVER_SSH_MACHINES_CHANNELS.uninstallAnswer, { runId: state.runId, promptId: state.prompt.id, value })
  }, [state])

  const confirm = async () => {
    const electron = api()
    if (!electron || !runId || !inspection?.supported || needsSignIn || othersSignedIn || agentCount === null || archiving) return
    setArchiving(true)
    setArchiveError('')
    try {
      if (!inspection.archiveReady && inspection.accounts.length > 0) await archiveServerTasks(device.device_id, listBoundAgents)
      else if (agentCount > 0) throw new Error(t('devices.uninstall.signInRequired'))
      if (!(await electron.invoke(SERVER_SSH_MACHINES_CHANNELS.uninstallConfirm, runId))) {
        throw new Error(t('devices.uninstall.confirmExpired'))
      }
    } catch (error) {
      setArchiveError(messageForUser(error))
    } finally {
      setArchiving(false)
    }
  }

  const retry = () => {
    setRunId(null)
    setStates({})
    setUnknownMachine(false)
    setAgentCount(null)
    setCountError(false)
    setArchiveError('')
    setAttempt(value => value + 1)
  }
  const uninstalling = archiving || phase === 'uninstalling' || (phase === 'done' && removed === null)
  const finished = phase === 'failed' || phase === 'cancelled' || (phase === 'done' && removed !== null)

  return (
    <Sheet
      onClose={uninstalling ? () => undefined : onClose}
      desktopWidth="440px"
      desktopMaxHeight="80vh"
      mobileFitContent
      ariaLabel={t('devices.uninstall.label', { name: device.label })}
      testId="settings-device-uninstall-dialog"
      zIndex="var(--z-settings-modal)"
    >
      <div className="flex flex-col gap-3 overflow-y-auto p-[18px]">
        <div className="text-[length:var(--font-title)] font-semibold text-[var(--fg)]">{t('devices.uninstall.title', { name: device.label })}</div>

        {unknownMachine && <div className={`${body} ${muted}`}>{t('devices.uninstall.unknownMachine')}</div>}

        {phase === 'inspecting' && !state?.prompt && (
          <div className={`${body} ${muted}`}>{t('devices.uninstall.connecting', { target: state?.target ?? address })}</div>
        )}
        {state?.prompt && <SshPromptCard prompt={state.prompt} onAnswer={answer} />}

        {phase === 'confirm' && inspection && !inspection.installed && (
          <div className={`${body} ${muted}`}>{t('devices.uninstall.notInstalled')}</div>
        )}

        {phase === 'confirm' && inspection?.installed && (
          <>
            <div className="flex flex-col gap-1">
              <div className={`${body} text-[var(--fg)]`}>{t('devices.uninstall.willDelete')}</div>
              <ul className={`${body} ${muted} m-0 list-disc pl-5`}>
                <li>{inspection.version ? t('devices.uninstall.deleteProgramVersion', { version: inspection.version }) : t('devices.uninstall.deleteProgram')}</li>
                <li>{t('devices.uninstall.revokeLogin')}</li>
              </ul>
              <div className={`${body} ${muted}`}>{inspection.home ? t('devices.uninstall.keepAt', { path: inspection.home }) : t('devices.uninstall.keep')}</div>
            </div>
            {inspection.accounts.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className={`${body} text-[var(--fg)]`}>{t('devices.uninstall.accounts')}</div>
                <ul className={`${body} ${muted} m-0 list-disc pl-5`} data-testid="settings-device-uninstall-accounts">
                  {inspection.accounts.map((account, index) => (
                    <li key={`${account.email ?? 'unknown'}-${index}`}>
                      {account.email ?? t('devices.uninstall.unknownAccount')}
                      {account.you && t('devices.uninstall.you')}
                      {!account.signedIn && t('devices.uninstall.signedOut')}
                    </li>
                  ))}
                </ul>
                {othersSignedIn && <div className={`${body} text-[var(--warn-fg)]`}>{t('devices.uninstall.otherAccount')}</div>}
              </div>
            )}
          </>
        )}

        {phase === 'confirm' && inspection?.installed && (
          <div className={`${body} ${muted}`}>
            {!inspection.supported ? t('devices.uninstall.updateRequired') : needsSignIn ? t('devices.uninstall.signInRequired') :
              countError ? t('devices.uninstall.countFailed') : agentCount === null ? t('devices.checkingAgents') :
                t('devices.uninstall.boundAgents', { count: agentCount })}
          </div>
        )}
        {archiveError && <div role="alert" className={`${body} text-[var(--danger-fg)]`}>{t('devices.uninstall.archiveFailed', { reason: archiveError })}</div>}

        {uninstalling && <div className={`${body} ${muted}`}>{t(archiving ? 'devices.uninstall.archiving' : 'devices.uninstall.uninstalling')}</div>}

        {phase === 'done' && removed !== null && (
          <div className={`${body} text-[var(--fg)]`}>
            {removed === true ? t('devices.uninstall.done', { target: state?.target ?? address }) : removed}
          </div>
        )}

        {phase === 'failed' && state?.failure && (
          <div className={`${body} text-[var(--danger-fg)]`}>
            {state.failure.detail ? messageForUser(state.failure.detail) : t('devices.uninstall.failed', { reason: t(reasonKey(state.failure.reason)) })}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {!finished && !uninstalling && <Button size="sm" onClick={onClose}>{t('devices.cancel')}</Button>}
          {phase === 'confirm' && inspection?.installed && !archiving && (
            <Button size="sm" variant="danger" disabled={!inspection.supported || needsSignIn || othersSignedIn || agentCount === null} onClick={() => void confirm()}>{t('devices.uninstall.confirm')}</Button>
          )}
          {((phase === 'confirm' && inspection && !inspection.installed) || unknownMachine) && (
            <Button size="sm" variant="danger" onClick={onRemoveOnly}>{t('devices.uninstall.removeFromList')}</Button>
          )}
          {(phase === 'failed' || countError) && <Button size="sm" onClick={retry}>{t('devices.uninstall.retry')}</Button>}
          {finished && <Button size="sm" variant={phase === 'done' ? 'primary' : 'secondary'} onClick={onClose}>{t('devices.uninstall.close')}</Button>}
        </div>
      </div>
    </Sheet>
  )
}
