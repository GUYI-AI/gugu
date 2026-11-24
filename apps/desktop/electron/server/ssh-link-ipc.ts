/**
 * #6264 设备连接(ssh-link.ts)接到渲染层:open / send / close,以及人点「登录」那一下(signIn)。
 * 契约见 src/lib/sshLink.ts。
 *
 * signIn:后台开的设备连接一律不弹问(BatchMode);要密码 / 口令 / 新主机指纹的机器,由人点「登录」,
 * 这里用与直连终端同一套 askpass + 提问卡片问一次,登上后共享连接一直留着(ControlPersist),再开设备连接不再问;
 * Windows 自带的 OpenSSH 没有共享连接,这一下记住的是新指纹(known_hosts)与装上的咕咕钥匙,之后 BatchMode 直接连上。
 * 密码提问上照样给「以后连这台机器不用再输密码」(下次免密,见 ssh-key-install.ts)。
 */
import { spawn } from '@gugu/core/local/childProcess'
import type { BrowserWindow } from 'electron'
import {
  SSH_LINK_CHANNELS,
  sshPathFailed,
  type SshLinkAnswer,
  type SshLinkFailure,
  type SshLinkOpenResult,
  type SshUpgradeEvent,
} from '../../src/lib/sshLink'
import type { TunnelMachines } from './tunnel-machines'
import type { SshKeyInstallOutcome } from '../../src/session/shared/ssh-prompt'
import type { DirectTerminalAskpass } from '../session/main/core/pty/direct-terminal/ssh-connect'
import { createSshAutoUpgrader, sshServerUpgradeRunner, type SshAutoUpgrader } from './ssh-install/auto-upgrade'
import { buildEnsureMasterArgs, classifySshFailure } from './ssh-install/logic'
import { systemSpawnSsh } from './ssh-install/system'
import type { DeviceCapabilities } from '@gugu/core/shared/types/chat'
import type { DeviceRpcRequester } from '@gugu/core/cloud/deviceRpcRequester'
import type { SharedSshLinks } from '../device-rpc-requester'
import type { HeldFileSshLinks } from '../projectFileSsh'
import { createSshLinkManager, type SshLinkManager } from './ssh-link'
import { findSshMachine, sshTargetOf, terminalControlPath, type SshMachine, type SshMachineStore } from './ssh-machines'
import { createTerminalAskpass } from './ssh-prompts'

const ID = /^[A-Za-z0-9_-]{1,128}$/

/** 与会话页「下次免密」提示同一条事件(src/session/shared/ssh-key-install.ts)。 */
const KEY_INSTALL_EVENT = 'ssh-key-install:done'

/**
 * 设备连接开不起来的原因交给渲染层之前:太旧的,这台桌面够得着就当场替它升级,报「正在更新」;
 * 冷却中 / 没有升级器 = 如实报太旧。纯函数(升级器注入)。
 */
export function openOutcome(
  deviceId: string,
  result: { ok: true } | { ok: false; reason: SshLinkFailure },
  upgrader: Pick<SshAutoUpgrader, 'request'> | null,
): SshLinkOpenResult {
  if (result.ok) return result
  if (result.reason === 'outdated' && upgrader?.request(deviceId)) return { ok: false, reason: 'updating' }
  return { ok: false, reason: result.reason }
}

/** 登录那一下的 ssh 结束了:成没成、没成为什么。纯函数。 */
export function classifySignInExit(code: number | null, stderr: string): { ok: true } | { ok: false; reason: SshLinkFailure } {
  if (code === 0) return { ok: true }
  const failure = classifySshFailure(stderr)
  if (failure === 'authFailed' || failure === 'hostKeyRejected') return { ok: false, reason: 'signInRequired' }
  if (failure === 'hostKeyChanged') return { ok: false, reason: 'hostKeyChanged' }
  return { ok: false, reason: 'unreachable' }
}

export function registerSshLinkIpc(options: {
  ipcMain: Electron.IpcMain
  getWindow: () => BrowserWindow | null
  store: SshMachineStore
  currentUserId: () => Promise<string | null>
  installKey?: (machine: SshMachine, controlPath: string | null, password: string) => Promise<SshKeyInstallOutcome>
  log?: (message: string, fields?: Record<string, unknown>) => void
  /** 太旧时替它升级装哪条通道(与桌面自己的更新通道一致);不给 = 不替它升级(只报太旧)。 */
  upgradeChannel?: 'stable' | 'beta'
  /** 单测替身;默认按 upgradeChannel 真升。 */
  upgrader?: SshAutoUpgrader
  /** Heartbeat facts and update requests use the same owner-bound device path as the device page. */
  readCapabilities?: (deviceId: string) => Promise<DeviceCapabilities | null>
  callUpdate?: DeviceRpcRequester['call']
  /**
   * 远程隧道:这台电脑没有它的 SSH 映射、但经中转连通了的机器(tunnel-machines.ts)。设备连接照样开在它上面;
   * 不替它升级(它自己经咕咕云升级)、不问登录(只用咕咕钥匙)。
   */
  tunnels?: Pick<TunnelMachines, 'linkMachine' | 'reportBroken' | 'linkRefused' | 'linkOpened'>
}): SshLinkManager & SharedSshLinks & HeldFileSshLinks {
  const send = (channel: string, payload: unknown) => {
    const win = options.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const machineFor = async (deviceId: string): Promise<SshMachine | null> => {
    const userId = (await options.currentUserId().catch(() => null)) ?? null
    return userId ? findSshMachine(options.store.list(), deviceId, userId) : null
  }
  // A tunnel's link that failed: the SSH path itself (rebuild the route now), or the machine's server said no (the route
  // works; the tunnel steps aside for Gugu Cloud and tries again on its backoff).
  const reportTunnelLink = (deviceId: string, reason: SshLinkFailure, detail?: string) => {
    if (sshPathFailed(reason)) options.tunnels?.reportBroken(deviceId)
    else options.tunnels?.linkRefused(deviceId, detail ? `${reason}: ${detail}` : reason)
  }
  // 同一条连接,窗口之外主进程也在用(agent 的 session_* 跨机器,main.ts):它们按机器挂在这里,❌ 各开一条。
  const taps = new Map<string, Set<Parameters<SharedSshLinks['tap']>[1]>>()
  const links = createSshLinkManager({
    machineFor: async (deviceId) => {
      const machine = await machineFor(deviceId)
      if (machine) return { target: sshTargetOf(machine), accountUserId: machine.ownerUserId }
      const tunnel = options.tunnels?.linkMachine(deviceId)
      return tunnel ? { ...tunnel, via: 'tunnel' } : null
    },
    controlPath: terminalControlPath,
    onMessage: (deviceId, message) => {
      send(SSH_LINK_CHANNELS.message, { deviceId, message })
      for (const tap of [...(taps.get(deviceId) ?? [])]) tap.onMessage(message)
    },
    onData: (deviceId, piece) => {
      for (const tap of [...(taps.get(deviceId) ?? [])]) tap.onData?.(piece)
    },
    onClosed: (deviceId, failure) => {
      const viaTunnel = !!options.tunnels?.linkMachine(deviceId)
      send(SSH_LINK_CHANNELS.closed, { deviceId, reason: failure.reason, ...(viaTunnel ? { via: 'tunnel' } : {}) })
      for (const tap of [...(taps.get(deviceId) ?? [])]) tap.onClosed(failure.reason)
      // 经中转的那条 SSH 断了(中转、网络):让远程隧道重新连一遍(❌ 留着一个看起来通着的映射)。
      // 那台机器的 server 自己答「不行」(没装、没在跑、没登这个账号…)时路是通的:重建只会再撞一次同一个答案,按退避再试。
      if (viaTunnel) reportTunnelLink(deviceId, failure.reason, failure.detail)
    },
    log: options.log,
  })
  // 主动收掉不报 onClosed(ssh-link.ts):窗口那头关、机器被移除时,挂着的那几位(主进程)由这里告诉,否则它们一直以为线还在。
  const rawClose = links.close
  const close = (deviceId: string) => {
    holds.delete(deviceId); deferred.delete(deviceId)
    rawClose(deviceId)
    for (const tap of [...(taps.get(deviceId) ?? [])]) tap.onClosed('closed')
  }
  // A file read in main holds the link (`hold`): the window letting go of its own use (its pipe reset, nobody listening)
  // waits for the read, which would otherwise die mid-file. Removing the machine or quitting still closes at once (`close`).
  const holds = new Map<string, number>(), deferred = new Set<string>()
  const hold = (deviceId: string) => {
    holds.set(deviceId, (holds.get(deviceId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (holds.get(deviceId) ?? 1) - 1
      if (left > 0) return void holds.set(deviceId, left)
      holds.delete(deviceId)
      if (deferred.delete(deviceId)) close(deviceId)
    }
  }
  const windowClose = (deviceId: string) => {
    if (holds.has(deviceId)) return void deferred.add(deviceId)
    close(deviceId)
  }
  const tap: SharedSshLinks['tap'] = (deviceId, handlers) => {
    const set = taps.get(deviceId) ?? new Set()
    set.add(handlers)
    taps.set(deviceId, set)
    return () => {
      set.delete(handlers)
      if (set.size === 0 && taps.get(deviceId) === set) taps.delete(deviceId)
    }
  }
  const channel = options.upgradeChannel
  const upgrader: SshAutoUpgrader | null =
    options.upgrader ??
    (channel
      ? createSshAutoUpgrader({
          run: sshServerUpgradeRunner({
            targetFor: async (deviceId) => {
              const machine = await machineFor(deviceId)
              return machine ? sshTargetOf(machine) : null
            },
            currentUserId: options.currentUserId,
            readCapabilities: deviceId => {
              if (!options.readCapabilities) throw new Error('Server update capabilities are unavailable')
              return options.readCapabilities(deviceId)
            },
            call: (...args) => {
              if (!options.callUpdate) throw new Error('The shared device requester is unavailable')
              return options.callUpdate(...args)
            },
            controlPath: terminalControlPath,
            channel,
            spawnSsh: systemSpawnSsh(process.env),
          }),
          emit: (event: SshUpgradeEvent) => send(SSH_LINK_CHANNELS.upgradeState, event),
          log: options.log,
        })
      : null)

  options.ipcMain.handle(SSH_LINK_CHANNELS.open, async (_event, deviceId: unknown): Promise<SshLinkOpenResult> => {
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) return { ok: false, reason: 'unmapped' }
    // The window uses the link again: a close it asked for while a read held it no longer stands.
    deferred.delete(deviceId)
    // 正在替它升级:这时开出去只会撞上还没换下来的旧版本,❌ 再起一个 ssh。
    const updating = upgrader?.upgrading(deviceId) === true
    if (updating && !links.isOpen(deviceId)) return { ok: false, reason: 'updating' }
    // 原因的原文只进日志(ssh-link.ts 已记),渲染层只拿原因码。
    const result = await links.open(deviceId)
    // 经远程隧道的机器:不替它升级(它自己经咕咕云换版本);SSH 这一段连不上 = 中转那条路坏了,让远程隧道重连。
    if (!(await machineFor(deviceId)) && options.tunnels?.linkMachine(deviceId)) {
      if (result.ok) options.tunnels.linkOpened(deviceId)
      else reportTunnelLink(deviceId, result.reason, result.detail)
      return result.ok ? result : { ...result, via: 'tunnel' }
    }
    const outcome: SshLinkOpenResult = updating ? { ok: false, reason: 'updating' } : openOutcome(deviceId, result, upgrader)
    return !result.ok && result.controlOnly && !outcome.ok ? { ...outcome, controlOnly: true } : outcome
  })
  options.ipcMain.handle(SSH_LINK_CHANNELS.upgrade, async (_event, request: { deviceId?: unknown; force?: unknown; desktopTooOld?: unknown; now?: unknown }) => {
    if (!request || typeof request.deviceId !== 'string' || !ID.test(request.deviceId) || !upgrader) return false
    if (!(await machineFor(request.deviceId))) return false
    return upgrader.request(request.deviceId, { force: request.force === true, desktopTooOld: request.desktopTooOld === true, now: request.now === true })
  })
  options.ipcMain.handle(SSH_LINK_CHANNELS.send, (_event, request: { deviceId?: unknown; message?: unknown }) => {
    if (!request || typeof request.deviceId !== 'string') return false
    return links.send(request.deviceId, request.message)
  })
  options.ipcMain.handle(SSH_LINK_CHANNELS.close, (_event, deviceId: unknown) => {
    if (typeof deviceId === 'string') windowClose(deviceId)
  })

  // ── 登录(人点的那一下)──────────────────────────────────────────────────────
  const signIns = new Map<string, { askpass: DirectTerminalAskpass | null; done: Promise<SshLinkOpenResult> }>()
  options.ipcMain.handle(SSH_LINK_CHANNELS.signIn, async (_event, deviceId: unknown): Promise<SshLinkOpenResult> => {
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) return { ok: false, reason: 'unmapped' }
    const running = signIns.get(deviceId)
    if (running) return running.done
    const entry: { askpass: DirectTerminalAskpass | null; done: Promise<SshLinkOpenResult> } = {
      askpass: null,
      done: Promise.resolve({ ok: false, reason: 'unmapped' }),
    }
    entry.done = (async (): Promise<SshLinkOpenResult> => {
      const machine = await machineFor(deviceId)
      const controlPath = terminalControlPath()
      if (!machine) return { ok: false, reason: 'unmapped' }
      const install = options.installKey
      const askpass = await createTerminalAskpass(
        undefined,
        install ? (password) => install(machine, controlPath, password) : undefined,
      )
      entry.askpass = askpass
      askpass.onPrompt((prompt) => send(SSH_LINK_CHANNELS.prompt, { deviceId, prompt }))
      askpass.onKeyInstall?.((outcome) => send(KEY_INSTALL_EVENT, { label: machine.display, outcome }))
      let installing: Promise<void> | void
      try {
        const exit = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
          const child = spawn('ssh', buildEnsureMasterArgs(sshTargetOf(machine), controlPath), {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, ...askpass.env },
          })
          let stderr = ''
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            if (stderr.length < 16_384) stderr += chunk
          })
          child.on('error', (error) => resolve({ code: null, stderr: error.message }))
          child.on('close', (code) => resolve({ code, stderr }))
        })
        const outcome = classifySignInExit(exit.code, exit.stderr)
        if (!outcome.ok) {
          options.log?.('ssh link: sign-in failed', { deviceId, code: exit.code, detail: exit.stderr.trim().split(/\r?\n/).slice(-3).join('\n') })
          return outcome
        }
        installing = askpass.authenticated?.()
      } finally {
        send(SSH_LINK_CHANNELS.prompt, { deviceId, prompt: null })
        // 装钥匙不用这个 askpass(复用共享连接,没有就自己带着刚答的密码再登一次):它的目录与套接字此刻就能收掉。
        void askpass.close()
      }
      // 勾了「以后不用再输密码」:钥匙装好再开设备连接 —— 没有共享连接(Windows)时,设备连接靠的就是这把钥匙。
      await installing
      return openOutcome(deviceId, await links.open(deviceId), upgrader)
    })()
    signIns.set(deviceId, entry)
    try {
      return await entry.done
    } finally {
      signIns.delete(deviceId)
    }
  })
  options.ipcMain.handle(SSH_LINK_CHANNELS.answer, (_event, answer: SshLinkAnswer) => {
    if (!answer || typeof answer.deviceId !== 'string' || typeof answer.promptId !== 'string') return false
    const askpass = signIns.get(answer.deviceId)?.askpass
    if (!askpass) return false
    return askpass.answer(answer.promptId, answer.value, answer.installKey ? { installKey: true } : undefined)
  })

  // 机器被移除 / 忘掉:它的设备连接当场收掉(❌ 留一条通到已经不归这台桌面管的机器的连接)。
  options.store.onChange(() => {
    const known = new Set(options.store.list().map((m) => m.deviceId))
    for (const deviceId of links.openDeviceIds()) if (!known.has(deviceId)) close(deviceId)
  })
  // closeAll 经 this.close 收,也走上面那一层。
  return Object.assign(links, { close, tap, hold, async owned(deviceId: string, accountId: string) {
    return (await options.currentUserId()) === accountId && !!findSshMachine(options.store.list(), deviceId, accountId)
  } })
}
