import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { serverMachineNotices, serverSupportsConfirmedRestart } from '@gugu/core/cloud/serverMachineHealth'
import { readServerVersionSwitchBusyAgents, restartServerVersionNow, retryServerVersionMatch } from '../lib/serverVersionRetry'
import type { Device } from '@gugu/core/shared/types/chat'
import { reportedSshUpdate } from '../lib/sshLinkOnline'
import { openDeviceRecovery } from '@/lib/deviceActionsIntent'
import type { SshLinkFailure, SshLinkOpenResult } from '../lib/sshLink'
import { sshLinkNoticeReason, type SshLinkNotice } from '../lib/sshLinkNotice'
import {
  answerSshSignInPrompt,
  isSshMachine,
  requestSshServerUpgrade,
  signInSshMachine,
  sshReinstallCommand,
  subscribeSshSignInPrompts,
  subscribeSshUpgradeEvents,
} from '../lib/sshLinkChannel'
import type { SshPrompt } from '../session/shared/ssh-prompt'
import { useDevicesStore } from '../store/devicesContext'
import { canRestartServerUpdate } from '../lib/deviceRowModel'
import { useSessionMessages } from '../session/renderer/localization/use-session-messages'
import { SshIdentityDetails } from './settings/addServer/SshHostKeyChanged'
import { SshPromptCard, SshPromptFrame } from './settings/addServer/SshPromptCard'
import { Button } from './ui/Button'
import { InlineAction } from './settings/addServer/InlineAction'
import { CommandBlock } from './settings/addServer/CommandBlock'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { Server } from '@/lib/icons'
import { useToast } from './toastContext'
import { useNotice, type Notice } from '@/lib/notices'
import { messageForUser } from '@/lib/userFacingError'
import { useSshLinkProblems } from '../hooks/useSshLinkProblems'

// #6264 远程 SSH 的机器:这台电脑与它之间只走 SSH(product spec「两种连法，处处能用」)。
// 连不上时 ❌ 退回咕咕云,各个模块照常报「问不到」;「怎么修」只在这一处说 —— 横幅位上的一条常驻提示
// (卡里是与远端终端上那张 SSH 提问卡片同一副内容):
//  · 要人回答(密码 / 口令 / 新主机指纹)才连得上:❌ 自己出面;人在用到那台机器的地方点了「登录」,提问浮在这张卡片里;
//  · 版本太旧:这台电脑当场替它更新(照 VS Code Remote-SSH),卡片说「正在更新」,升完自动连上、卡片收起;
//    没更新成就说没成,句子里一段「重试」;老到没法自动更新的,给出在那台机器上重装的那一行命令;
//  · 指纹变了 / 被拒绝 / 没登这个账号 / 没装:如实说(被拒绝 ❌ 当成太旧去升级 —— 升级只因为版本)。
// 后台开的连接从不自己弹问(BatchMode),所以人不点就不会被突然问密码;收起之后同一台同一种原因不再出现。
//  · 版本对不上、那台机器上有 agent 在跑(它在等空闲再换):问人「现在重启更新」,收起 = 稍后。远程隧道的机器也在这里问
//    (它的心跳报「装好了、等空闲」+ 协议太旧),可确认时走设备行的显式目标重启,只有人点的请求才不等空闲。

export function SshLinkSignIn() {
  const { t } = useTranslation('settings')
  const { devices } = useDevicesStore()
  const { toast } = useToast()
  const problems = useSshLinkProblems()
  const [prompts, setPrompts] = useState<ReadonlyMap<string, SshPrompt>>(() => new Map())

  useEffect(() => subscribeSshUpgradeEvents(event => {
    if (event.phase !== 'unconfirmed') return
    toast(t('devices.update.restartUnconfirmed', {
      name: devices.find(device => device.device_id === event.deviceId)?.label ?? event.deviceId,
      version: event.reportedVersion ?? t('devices.versionUnknown'),
    }), 'info')
  }), [devices, t, toast])
  useEffect(() => subscribeSshSignInPrompts(({ deviceId, prompt }) => {
    setPrompts(previous => {
      const next = new Map(previous)
      if (prompt) next.set(deviceId, prompt)
      else next.delete(deviceId)
      return next
    })
  }), [])

  return <>{devices.map(machine => <MachineNotice key={machine.device_id} machine={machine}
    problem={problems.get(machine.device_id) ?? null} prompt={prompts.get(machine.device_id) ?? null} />)}</>
}

function MachineNotice({ machine, problem, prompt }: { machine: Device; problem: SshLinkFailure | null; prompt: SshPrompt | null }) {
  const { t } = useTranslation('settings')
  const { translate } = useSessionMessages()
  const { toast } = useToast()
  const [dismissed, setDismissed] = useState<SshLinkFailure | null>(null)
  const [verification, setVerification] = useState<Extract<SshLinkOpenResult, { ok: false }> | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [answered, setAnswered] = useState<string | null>(null)
  const [confirmRestart, setConfirmRestart] = useState<{ deviceId: string; busyAgents?: number | null } | null>(null)
  const ssh = isSshMachine(machine.device_id)
  const update = machine.capabilities?.server_update
  const tunnelWaiting = !ssh && machine.is_online && update?.state === 'ready'
    && serverMachineNotices(machine.capabilities).some(notice => notice.kind === 'server-too-old')
  const reason = prompt ? 'signInRequired' : signingIn ? (problem === 'hostKeyChanged' ? 'hostKeyChanged' : 'signInRequired') : sshLinkNoticeReason(reportedSshUpdate(machine, problem)) ?? (tunnelWaiting ? 'waitingIdle' : null)
  const pendingRestart = reason === 'waitingIdle' || reason === 'confirmationRequired'
  if (verification && problem !== 'hostKeyChanged') setVerification(null)
  if (confirmRestart && !pendingRestart) setConfirmRestart(null)
  if (dismissed !== null && dismissed !== reason) setDismissed(null)
  const shown = reason && (prompt || signingIn || reason !== dismissed)
    ? { deviceId: machine.device_id, name: machine.label, reason } : null
  useNotice(`ssh-link:${machine.device_id}`, shown && card(shown))
  return null

  function card(shown: SshLinkNotice): Omit<Notice, 'key'> {
    const confirmableUpdate = !ssh && update?.state === 'ready' && canRestartServerUpdate(update, machine.capabilities) ? update : null

    const startSignIn = () => {
      const deviceId = shown.deviceId
      setSigningIn(true)
      void signInSshMachine(deviceId).then(result => {
        setVerification(!result.ok && result.reason === 'hostKeyChanged' ? result : null)
      }).finally(() => {
        setSigningIn(false)
        setAnswered(null)
      })
    }
    const dismiss = () => { setDismissed(shown.reason); setVerification(null) }
    const askRestart = () => {
      const question = { deviceId: shown.deviceId, busyAgents: null }
      setConfirmRestart(question)
      void readServerVersionSwitchBusyAgents(shown.deviceId).then(busyAgents => {
        setConfirmRestart(current => current === question ? { ...question, busyAgents } : current)
      })
    }
    // Keep the SSH upgrader; restartable cloud targets use the device row's explicit confirmation.
    const restartNow = async () => {
      const deviceId = shown.deviceId
      setConfirmRestart(null)
      const failed = (error?: unknown) => toast(t('devices.update.restartFailed', { name: shown.name }), 'error', error ? messageForUser(error) : undefined)
      try {
        let requested = true
        if (isSshMachine(deviceId)) requested = await requestSshServerUpgrade(deviceId, { force: true, now: true })
        else if (confirmableUpdate) requested = (await restartServerVersionNow(deviceId, confirmableUpdate.version, serverSupportsConfirmedRestart(machine.capabilities))).requested
        else requested = await retryServerVersionMatch(deviceId)
        if (!requested) { failed(); return }
        setDismissed(shown.reason)
      } catch (error) { failed(error) }
    }
    const activePrompt = prompt
    const canSignIn = shown.reason === 'signInRequired' || shown.reason === 'hostKeyChanged'
    const reinstall = shown.reason === 'updateFailed' ? sshReinstallCommand(shown.deviceId) : null

    // 关闭钮:在提问就是取消这次提问;在连就只收起「连接中」(有提问来会再出现);其余 = 这台这种原因不再出现(waitingIdle 即「稍后」)。
    const close = () => {
      if (activePrompt) answerSshSignInPrompt({ deviceId: shown.deviceId, promptId: activePrompt.id, value: null })
      else if (signingIn) setSigningIn(false)
      else dismiss()
    }
    // 机器名是这条横幅的标题(带服务器图标),下面平铺那一句和按钮 —— ❌ 横幅里再套一张卡。
    return { ongoing: true, onDismiss: close, title: shown.name, icon: <Server size={16} />, description: (
        <div data-testid="ssh-link-sign-in">
          {pendingRestart && !activePrompt ? (
            // 版本对不上、那台机器在等 agent 空闲:与 SSH 提问同一副卡(机器名一行 + 一句 + 底行按钮),「现在」先当面确认一次。
            <SshPromptFrame
              testId={confirmRestart?.deviceId === shown.deviceId ? 'ssh-link-update-confirm' : 'ssh-link-update-ask'}
              actions={
                confirmRestart?.deviceId === shown.deviceId ? (
                  <>
                    <Button size="sm" onClick={() => setConfirmRestart(null)} data-testid="ssh-link-update-cancel">{t('devices.cancel')}</Button>
                    <Button size="sm" variant="primary" autoFocus disabled={confirmRestart.busyAgents === null} onClick={restartNow} data-testid="ssh-link-update-confirm-now">{t('devices.link.confirmRestart')}</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" onClick={dismiss} data-testid="ssh-link-update-later">{t('devices.link.later')}</Button>
                    <Button size="sm" variant="primary" autoFocus onClick={askRestart} data-testid="ssh-link-update-now">{t('devices.link.updateNow')}</Button>
                  </>
                )
              }
            >
              <p className="m-0 text-[length:var(--font-body)] leading-[1.5]">
                {confirmRestart?.deviceId === shown.deviceId
                  ? t(typeof confirmRestart.busyAgents === 'number' ? 'devices.update.updateNowConfirmCount' : 'devices.update.updateNowConfirm', { name: shown.name, count: confirmRestart.busyAgents ?? undefined })
                  : confirmableUpdate
                    ? translate('remoteHost.notice.updateReady', { device: shown.name, version: confirmableUpdate.version })
                    : t(shown.reason === 'confirmationRequired' ? 'devices.link.confirmationRequired' : 'devices.link.waitingIdle', { name: shown.name })}
              </p>
            </SshPromptFrame>
          ) : activePrompt ? (
            <SshPromptCard
              prompt={activePrompt}
              pending={answered === activePrompt.id}
              variant="floating"
              cancellable
              onAnswer={(value, extra) => {
                if (value !== null) setAnswered(activePrompt.id)
                answerSshSignInPrompt({
                  deviceId: shown.deviceId,
                  promptId: activePrompt.id,
                  value,
                  ...(extra?.installKey ? { installKey: true } : {}),
                })
              }}
            />
          ) : (
            <div>
              <p className="m-0 min-w-0 flex-1 text-[length:var(--font-body)] leading-[1.5]">
                {signingIn || shown.reason === 'updating' ? (
                  <span className="inline-flex items-center gap-2 text-muted-foreground" data-testid="ssh-link-busy">
                    <LoadingIndicator size="inline" />
                    {t(signingIn ? 'devices.link.connecting' : 'devices.link.updating', { name: shown.name })}
                  </span>
                ) : reinstall ? (
                  <span className="flex flex-col gap-2" data-testid="ssh-link-reinstall">
                    {t('devices.link.reinstall', { name: shown.name })}
                    <CommandBlock command={reinstall} testId="ssh-link-reinstall-command" />
                  </span>
                ) : (
                  <>
                    {t(`devices.link.${shown.reason}`, { name: shown.name })}
                    {verification?.hostKey && <SshIdentityDetails hostKey={verification.hostKey} />}
                    {['notSignedIn', 'notInstalled', 'notRunning', 'refused'].includes(shown.reason) && <>
                      {' '}<InlineAction onClick={() => { dismiss(); openDeviceRecovery(shown.deviceId) }}>{translate('remoteHost.ssh.settings')}</InlineAction>
                    </>}
                    {shown.reason === 'updateFailed' ? (
                      <>
                        {' '}
                        <InlineAction onClick={() => void requestSshServerUpgrade(shown.deviceId, { force: true })} testId="ssh-link-upgrade-retry">
                          {t('devices.link.retryUpdate')}
                        </InlineAction>
                      </>
                    ) : null}
                    {canSignIn ? (
                      <>
                        {' '}
                        <InlineAction onClick={startSignIn} testId="ssh-link-sign-in-action">
                          {shown.reason === 'hostKeyChanged' ? (verification ? t('devices.retry') : translate('remoteHost.ssh.verify')) : t('devices.link.signIn')}
                        </InlineAction>
                      </>
                    ) : null}
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      ) }
  }
}
