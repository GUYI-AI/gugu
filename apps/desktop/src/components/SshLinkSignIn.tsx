import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { serverMachineNotices, serverSupportsConfirmedRestart } from '@gugu/core/cloud/serverMachineHealth'
import { readServerVersionSwitchBusyAgents, restartServerVersionNow, retryServerVersionMatch } from '../lib/serverVersionRetry'
import type { SshLinkFailure } from '../lib/sshLink'
import { pickSshLinkNotice, type SshLinkNotice } from '../lib/sshLinkNotice'
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
  const { translate } = useSessionMessages()
  const { devices } = useDevicesStore()
  const { toast } = useToast()
  const problems = useSshLinkProblems()
  const [dismissed, setDismissed] = useState<ReadonlyMap<string, SshLinkFailure>>(() => new Map())
  const [signingIn, setSigningIn] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<{ deviceId: string; prompt: SshPrompt } | null>(null)
  const [answered, setAnswered] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState<{ deviceId: string; busyAgents?: number | null } | null>(null)

  useEffect(() => subscribeSshUpgradeEvents(event => {
    if (event.phase !== 'unconfirmed') return
    toast(t('devices.update.restartUnconfirmed', {
      name: devices.find(device => device.device_id === event.deviceId)?.label ?? event.deviceId,
      version: event.reportedVersion ?? t('devices.versionUnknown'),
    }), 'info')
  }), [devices, t, toast])
  useEffect(
    () =>
      subscribeSshSignInPrompts((event) => {
        setAnswered(false)
        setPrompt(event.prompt ? { deviceId: event.deviceId, prompt: event.prompt } : null)
      }),
    [],
  )

  const notice = useMemo(() => pickSshLinkNotice({ problems, machines: devices, dismissed }), [problems, devices, dismissed])
  const tunnelWaiting = useMemo(
    () =>
      devices.find(
        (d) =>
          !isSshMachine(d.device_id) &&
          d.is_online &&
          dismissed.get(d.device_id) !== 'waitingIdle' &&
          d.capabilities?.server_update?.state === 'ready' &&
          serverMachineNotices(d.capabilities).some((n) => n.kind === 'server-too-old'),
      ) ?? null,
    [devices, dismissed],
  )
  // 正在登录的那台优先(从哪里点的「登录」都一样,提问浮在这张卡片上;登录中它的原因会被清掉,卡片 ❌ 跳到别的机器上去)。
  const signingId = signingIn ?? prompt?.deviceId
  const signingMachine = signingId ? devices.find((d) => d.device_id === signingId) : null
  const shown: SshLinkNotice | null = signingMachine
    ? { deviceId: signingMachine.device_id, name: signingMachine.label, reason: 'signInRequired' }
    : (notice ?? (tunnelWaiting ? { deviceId: tunnelWaiting.device_id, name: tunnelWaiting.label, reason: 'waitingIdle' } : null))
  if (confirmRestart && (shown?.reason !== 'waitingIdle' || shown.deviceId !== confirmRestart.deviceId)) setConfirmRestart(null)
  useNotice('ssh-link', shown && card(shown))
  return null

  // The card for the machine shown: one persistent notice (the banner slot), its controls kept in this component's state.
  function card(shown: SshLinkNotice): Omit<Notice, 'key'> {
  const tunnelUpdate = !notice ? tunnelWaiting?.capabilities.server_update : undefined
  const confirmableUpdate = tunnelUpdate?.state === 'ready' && tunnelWaiting
    && canRestartServerUpdate(tunnelUpdate, tunnelWaiting.capabilities) ? tunnelUpdate : null

  const startSignIn = () => {
    const deviceId = shown.deviceId
    setSigningIn(deviceId)
    void signInSshMachine(deviceId).finally(() => {
      setSigningIn(null)
      setPrompt(null)
      setAnswered(false)
    })
  }
  const dismiss = () => setDismissed((prev) => new Map(prev).set(shown.deviceId, shown.reason))
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
      if (isSshMachine(deviceId)) await requestSshServerUpgrade(deviceId, { force: true, now: true })
      else if (confirmableUpdate && tunnelWaiting) requested = (await restartServerVersionNow(deviceId, confirmableUpdate.version, serverSupportsConfirmedRestart(tunnelWaiting.capabilities))).requested
      else requested = await retryServerVersionMatch(deviceId)
      if (!requested) { failed(); return }
      setDismissed((prev) => new Map(prev).set(deviceId, 'waitingIdle'))
    } catch (error) { failed(error) }
  }
  const activePrompt = prompt && prompt.deviceId === shown.deviceId ? prompt.prompt : null
  const canSignIn = shown.reason === 'signInRequired' || shown.reason === 'hostKeyChanged'
  const reinstall = shown.reason === 'outdated' ? sshReinstallCommand(shown.deviceId) : null

  // 关闭钮:在提问就是取消这次提问;在连就只收起「连接中」(有提问来会再出现);其余 = 这台这种原因不再出现(waitingIdle 即「稍后」)。
  const close = () => {
    if (activePrompt) answerSshSignInPrompt({ deviceId: shown.deviceId, promptId: activePrompt.id, value: null })
    else if (signingIn) setSigningIn(null)
    else dismiss()
  }
  // 机器名是这条横幅的标题(带服务器图标),下面平铺那一句和按钮 —— ❌ 横幅里再套一张卡。
  return { ongoing: true, onDismiss: close, title: shown.name, icon: <Server size={16} />, description: (
      <div data-testid="ssh-link-sign-in">
        {shown.reason === 'waitingIdle' && !activePrompt ? (
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
                  : t('devices.link.waitingIdle', { name: shown.name })}
            </p>
          </SshPromptFrame>
        ) : activePrompt ? (
          <SshPromptCard
            prompt={activePrompt}
            pending={answered}
            variant="floating"
            cancellable
            onAnswer={(value, extra) => {
              if (value !== null) setAnswered(true)
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
                  {shown.reason === 'outdated' ? (
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
                        {t('devices.link.signIn')}
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
