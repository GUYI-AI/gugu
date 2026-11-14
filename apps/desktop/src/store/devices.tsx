import { useEffect, useCallback, useMemo, useRef, useSyncExternalStore, useLayoutEffect } from 'react'
import { chatService } from '../lib/chat'
import { recentMachineLimitRefusal } from '../lib/device-labels'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'
import { isLocalDeviceUnidentified } from '../lib/localDeviceIdentity'
import { rendererLogger } from '../lib/log'
import { partitionPhones, sortDevices } from '../lib/devicesSort'
import { thisPhoneDeviceId } from '../mobile/phone-device/phoneDeviceSettings'
import { useAuth } from './auth'
import { useChatStore } from './chatContext'
import { DevicesContext } from './devicesContext'
import { publishDirectoryDevices } from '@/session/shared/remote-sessions/session-directory'
import type { Device } from '@gugu/core/shared/types/chat'
import { readDeviceRevision } from '../lib/accountRevisionCoordinator'
import type { AccountRevisionOperation } from '../lib/accountRevisionRuntime'
import { cachedDevicesAccount, devicesModel, readCachedDevices, writeCachedDevices } from './devicesCache'
import { useReadModel } from '../lib/readModel'
import { withDeviceProjects } from '@gugu/core/cloud/deviceProjects'
import { withProjectsRead } from './deviceProjectsRead'
import { listMyDeviceProjects } from '../lib/deviceProjects'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { withSshLinkOnline } from '../lib/sshLinkOnline'
import { useSshLinkProblems, useSshMachineIds } from '../hooks/useSshLinkProblems'
import { desktopIpc } from '../platform/desktopIpc'
import { platform } from '../platform'
import { SERVER_SSH_MACHINES_CHANNELS } from '../lib/serverSshMachines'
import { reportAssistantAppChange } from '../components/assistant/assistant-app-client'
import { useMyAssistant } from '../lib/myAssistant'
import { machineRpc } from '../mobile/agent-watch/sessionpage-rpc'
import {
  cloudComputerPollMs,
  cloudComputerWatchMs,
  getCloudComputerState,
  refreshCloudComputer,
  resetCloudComputerState,
  subscribeCloudComputerState,
  withCloudComputerPresence,
} from '../lib/cloudComputerStore'

// #1749 设备 store：list(chatService.listDevices，含本机 self-merge) + 排序 + durable revision 刷新
// (注册/心跳状态翻转/改名/删除都重拉) + rename/remove 动作。面板与 selector 共用这一份状态。
const devicesLog = rendererLogger('devices')

export function DevicesProvider({ children, active = true }: { children: React.ReactNode; active?: boolean }) {
  const { user: authenticatedUser, loading: authLoading } = useAuth()
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  const userId = active ? authenticatedUser?.id ?? null : null
  const assistant = useMyAssistant(userId, null)
  const appMachine = useMemo(() => assistant.provisionDeviceId ? { rpc: machineRpc(assistant.provisionDeviceId) } : null, [assistant.provisionDeviceId])
  // 第一帧就用上次那份铺开(读模型的快照),❌ 不是空列表 + 转圈;重读一返回就换成此刻的事实。
  // 界面还不活跃(active=false)时只画、不读。
  const reading = useReadModel(devicesModel, [], { read: userId !== null })
  const readError = reading.state === 'error' ? reading.error : reading.state === 'value' ? reading.error : null
  const error = readError ? String(readError.message ?? readError) : null
  // 列着的(含快照)各台的项目这一次没读到:标成「上次的」。
  const devices = useMemo(() => {
    if (reading.state !== 'value') return []
    const rows = sortDevices(reading.value)
    return error ? withProjectsRead(rows, error, rows) : rows
  }, [reading, error])
  const loading = userId !== null && reading.state === 'unknown'

  const refresh = useCallback(async () => {
    if (!userId) return
    await devicesModel.refresh()
  }, [userId])

  // 这台电脑在账号的设备里认出自己的那一刻(本机宿主拿到登录、查到自己那一行)再读一次:之前那次读分不出哪行是本机。
  // 订在首读之前:认出若发生在首读途中,这一声不会落空。
  useEffect(() => {
    if (!userId) return
    return platform.subscribeLocalDeviceIdentified?.(() => { void refresh() })
  }, [userId, refresh])


  // #7199 云电脑此刻怎样:管家的 /state 是事实源。换账号就清掉上一个账号的;登录后问一次。
  const cloudComputer = useSyncExternalStore(subscribeCloudComputerState, getCloudComputerState, getCloudComputerState)
  // 只在真换了账号时清:冷启动、刷新令牌时 userId 会短暂为 null(见 devicesCache.ts),那一下清掉会让云电脑闪成「离线」、
  // 作废在途的叫醒进度,还会让会话页把它当成「又睡着了」再叫一次。退出登录后设备列表本来就空了。
  const cloudAccountRef = useRef<string | null>(null)
  useEffect(() => {
    if (!userId) return
    if (cloudAccountRef.current !== userId) {
      cloudAccountRef.current = userId
      resetCloudComputerState()
    }
    void refreshCloudComputer().catch(() => undefined)
  }, [userId])

  // 账号上的项目(项目的唯一来源,桌面与手机同一份):登录的人交给它,什么时候再读由它自己订;登出清空。
  const signedOut = !authLoading && !authenticatedUser
  useEffect(() => {
    if (signedOut) {
      accountProjectsStore.clear()
      return
    }
    if (!userId) return
    return accountProjectsStore.start(userId, subscribeAccountRevision)
  }, [userId, signedOut, subscribeAccountRevision])

  // gugu_devices 任何增删改都落账号 revision journal。初始拉取 + durable cursor 覆盖订阅建立前与离线期间的变更。
  // 每条带着是哪一台、是那一行还是它的项目:只读变了的那一样(心跳每 30 秒一条,从前每条都把整个账号的设备和项目重读一遍)。
  // 云电脑睡下 / 醒来,它那一行的在线与否就会翻 ⇒ 顺带再问一次管家(❌ 让它拖住设备列表的游标)。
  const applyDeviceRevisions = useCallback(async (operations: readonly AccountRevisionOperation[]) => {
    if (!userId) return
    const changed = new Set<string>()
    const removed = new Set<string>()
    const projectsOf = new Set<string>()
    for (const operation of operations) {
      const key = readDeviceRevision(operation.payload)
      if (key.removed) removed.add(key.deviceId)
      else {
        if (key.row) changed.add(key.deviceId)
        if (key.projects) projectsOf.add(key.deviceId)
      }
    }
    let listed: Device[]
    let projects: Awaited<ReturnType<typeof listMyDeviceProjects>> | null
    try {
      [listed, projects] = await Promise.all([
        changed.size > 0 ? chatService.listDevices({ includePhones: true, deviceIds: [...changed] }) : Promise.resolve([]),
        projectsOf.size > 0 ? listMyDeviceProjects([...projectsOf]) : Promise.resolve(null),
      ])
    } catch (err) {
      // 与整读同一条:本机还没认出自己时不算失败,认出那一刻会整读一次(上面)。
      if (isLocalDeviceUnidentified(err)) return
      if (!isLifecycleCancellation(err)) {
        devicesLog.error({ err: String((err as Error)?.message ?? err) }, 'read changed devices failed')
        // 重读那几台的项目没成(游标会重试):重试成功前它们列着的是上次的。
        if (projectsOf.size > 0) writeCachedDevices(withProjectsRead(readCachedDevices(), String((err as Error)?.message ?? err), readCachedDevices(), projectsOf))
      }
      throw err
    }
    // 那几台此刻的样子(没读回来的 = 已经不在了);其余各台原样,项目没变就沿用。
    const fresh = listed.filter((row) => changed.has(row.device_id))
    const previous = readCachedDevices()
    const kept = previous.filter((row) => !changed.has(row.device_id) && !removed.has(row.device_id))
    const rows = withProjectsRead(withDeviceProjects([...kept, ...fresh], projects, previous, projectsOf), null, previous, projectsOf)
    writeCachedDevices(rows)
    if (removed.size > 0) void desktopIpc()?.invoke(SERVER_SSH_MACHINES_CHANNELS.reconcile, { owner: userId, present: rows.map((row) => row.device_id) }).catch(() => undefined)
  }, [userId])
  useEffect(() => {
    if (!userId) return
    return subscribeAccountRevision('device_changed', (operations) => {
      // 只有可能牵动云电脑的那几条才去问管家:它自己那一行(睡下 / 醒来)、新出现或被移除的一台(开通 / 销毁)。
      // 别的电脑每 30 秒一次的心跳摘要 ❌ —— 忙账号六七台机器,每次心跳都多一发管家请求。
      const cloudDeviceId = getCloudComputerState().snapshot?.deviceId ?? null
      const known = new Set(readCachedDevices().map((row) => row.device_id))
      if (operations.some((operation) => {
        const key = readDeviceRevision(operation.payload)
        return key.removed || key.deviceId === cloudDeviceId || !known.has(key.deviceId)
      })) void refreshCloudComputer().catch(() => undefined)
      return applyDeviceRevisions(operations)
    })
  }, [userId, applyDeviceRevisions, subscribeAccountRevision])

  // 切回窗口时再问一次(别的端开通 / 关掉了,或它在后台睡下了)。
  useEffect(() => {
    if (!userId || typeof document === 'undefined') return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshCloudComputer().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [userId])

  const rename = useCallback(async (deviceId: string, label: string) => {
    const ownerId = userId ?? cachedDevicesAccount()
    await chatService.renameDevice(deviceId, label)
    if (assistant.agentId || assistant.loading || assistant.error) await reportAssistantAppChange(appMachine, assistant.agentId ?? undefined, {
      resource: 'devices', operation: 'edited', id: deviceId, deviceId, after: { name: label },
    }, ownerId)
    await refresh()
  }, [refresh, assistant.agentId, assistant.loading, assistant.error, appMachine, userId])

  const remove = useCallback(async (deviceId: string, options: { cascade?: boolean } = {}) => {
    const ownerId = userId ?? cachedDevicesAccount()
    await chatService.removeDevice(deviceId, options)
    if (assistant.agentId || assistant.loading || assistant.error) await reportAssistantAppChange(appMachine, assistant.agentId ?? undefined, {
      resource: 'devices', operation: 'removed', id: deviceId, deviceId,
    }, ownerId)
    await refresh()
  }, [refresh, assistant.agentId, assistant.loading, assistant.error, appMachine, userId])

  // #6264 这台电脑用远程 SSH 添加的机器(清单随装上 / 移除一台跟着变):在不在线只看 SSH 设备连接(❌ 看咕咕云心跳),
  // 侧栏、选择器、设置 → 设备同一个说法。别的机器照常读心跳。
  const sshMachineIds = useSshMachineIds()
  const linkProblems = useSshLinkProblems()
  // #7199 云电脑那一行补上「休眠中 / 正在唤醒 / 运行中」,再排一次(休眠中的排在在线那一组)。
  const listedHere = useMemo(
    () =>
      sortDevices(
        withCloudComputerPresence(
          withSshLinkOnline(devices, sshMachineIds, linkProblems),
          cloudComputer.snapshot,
          Date.now(),
          cloudComputer.wakeRefused?.deviceId ?? null,
        ),
      ),
    [devices, sshMachineIds, linkProblems, cloudComputer.snapshot, cloudComputer.wakeRefused],
  )

  // #7199 手机(只被调动作,不是运行位置)单独一份:设置 → 设备列它,「在哪跑」、侧栏、各处机器选择只读 machines。
  // 在手机上,这台手机自己那一行标成本机。
  const thisPhoneId = useMemo(() => (platform.kind === 'capacitor' && userId ? thisPhoneDeviceId(userId) : null), [userId])
  const { machines, phones } = useMemo(() => partitionPhones(listedHere, thisPhoneId), [listedHere, thisPhoneId])
  const directoryDevices = useMemo(() => [...machines, ...phones], [machines, phones])
  // 布局期发布:头像角标、收回着与否从这份读,首帧就要是这份,❌ 先画一帧旧的再翻。
  useLayoutEffect(() => { publishDirectoryDevices(directoryDevices) }, [directoryDevices])

  // 开通、唤醒途中每 3 秒问一次管家(它的进度只在 /state 上),连设备列表一起刷。
  const pollMs = userId ? cloudComputerPollMs(cloudComputer.snapshot, listedHere) : null
  useEffect(() => {
    if (pollMs === null) return
    const timer = setInterval(() => {
      void refreshCloudComputer().catch(() => undefined)
      // 醒了的那台 server 上线时库里会翻一行,但开通途中的这几秒也顺带刷一下列表:新机器第一次出现得快一点。
      void refresh()
    }, pollMs)
    return () => clearInterval(timer)
  }, [pollMs, refresh])

  // 有云电脑、不在途中:每 30 秒问一次管家(它睡下 / 被别处叫醒时库里那一行要等心跳超时才翻,在不在以管家为准)。
  // 窗口在后台不问,切回来那一下上面会问。
  const watchMs = userId && pollMs === null ? cloudComputerWatchMs(cloudComputer.snapshot) : null
  useEffect(() => {
    if (watchMs === null) return
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refreshCloudComputer().catch(() => undefined)
    }, watchMs)
    return () => clearInterval(timer)
  }, [watchMs])

  const listBoundAgents = useCallback(async (deviceId: string) => {
    return chatService.listAgentsOnDevice(deviceId)
  }, [])

  // A fresh value on every provider render re-rendered every device reader (sidebar, composer, contacts sections) even when
  // the render changed nothing they read.
  const value = useMemo(
    () => ({ devices: machines, phones, loading, error, refresh, rename, remove, listBoundAgents, recentMachineLimitRefusal, cloudComputer }),
    [machines, phones, loading, error, refresh, rename, remove, listBoundAgents, cloudComputer],
  )
  return (
    <DevicesContext.Provider value={value}>
      {children}
    </DevicesContext.Provider>
  )
}
