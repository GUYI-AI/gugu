import { useEffect, useCallback, useMemo, useLayoutEffect } from 'react'
import { chatService } from '../lib/chat'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'
import { isLocalDeviceUnidentified } from '../lib/localDeviceIdentity'
import { rendererLogger } from '../lib/log'
import { partitionPhones, sortDevices } from '../lib/devicesSort'
import { usePhoneHostIdentity } from '../mobile/local-agent/usePhoneHostIdentity'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { useAuth } from './auth'
import { useChatStore } from './chatContext'
import { DevicesContext } from './devicesContext'
import { publishDirectoryDevices } from '@/session/shared/remote-sessions/session-directory'
import type { Device } from '@gugu/core/shared/types/chat'
import { readDeviceRevision } from '../lib/accountRevisionCoordinator'
import type { AccountRevisionOperation } from '../lib/accountRevisionRuntime'
import { cachedDevicesAccount, devicesModel, readCachedDevices } from './devicesCache'
import { useReplica } from '../lib/replica'
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
import { cloudComputer, cloudComputerPollMs, cloudSnapshotOf, knownCloudDeviceId, useCloudComputer, useWakeRefusal, withCloudComputerPresence } from '../lib/cloudComputer'

// #1749 设备 store：list(chatService.listDevices，含本机 self-merge) + 排序 + durable revision 刷新
// (注册/心跳状态翻转/改名/删除都重拉) + rename/remove 动作。面板与 selector 共用这一份状态。
const devicesLog = rendererLogger('devices')

export function DevicesProvider({ children, active = true }: { children: React.ReactNode; active?: boolean }) {
  const { user: authenticatedUser, loading: authLoading } = useAuth()
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  const userId = active ? authenticatedUser?.id ?? null : null
  const assistant = useMyAssistant()
  const assistantKnown = assistant.state === 'value' ? assistant.value : null
  // Tell the assistant App unless it is known there is none (not read yet / unreadable: the notice waits in its outbox).
  const reportsToAssistant = assistant.state !== 'value' || assistant.value.agentId !== null
  const appMachine = useMemo(() => assistantKnown?.provisionDeviceId ? { rpc: machineRpc(assistantKnown.provisionDeviceId) } : null, [assistantKnown?.provisionDeviceId])
  // 第一帧就用上次那份铺开(读模型的快照),❌ 不是空列表 + 转圈;重读一返回就换成此刻的事实。
  // 界面还不活跃(active=false)时只画、不读。
  const reading = useReplica(devicesModel, [], { read: userId !== null })
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


  // #7199 云电脑此刻怎样:replica `cloudComputer`(管家的 /state)。
  const cloud = useCloudComputer()
  // 开通、唤醒途中(管家每 3 秒问一次)每问到一次也重读设备列表:新机器第一次出现得快一点(❌ 只等 device_changed)。
  useEffect(() => {
    if (!userId) return
    let asking = false
    return cloudComputer.subscribe([], ({ reading, fetching }) => {
      const answered = asking && !fetching
      asking = fetching
      if (!answered || reading.state !== 'value' || !reading.value.available) return
      if (cloudComputerPollMs(reading.value.snapshot, readCachedDevices()) !== null) void devicesModel.refresh()
    })
  }, [userId])
  const cloudSnapshot = cloudSnapshotOf(cloud)
  const refused = useWakeRefusal(cloudSnapshot)

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
    // Bound to the account asking: rows that answer after a switch do not land in the next account's list.
    const cache = devicesModel.at()
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
        if (projectsOf.size > 0) cache.set(withProjectsRead(readCachedDevices(), String((err as Error)?.message ?? err), readCachedDevices(), projectsOf))
      }
      throw err
    }
    // 那几台此刻的样子(没读回来的 = 已经不在了);其余各台原样,项目没变就沿用。
    const fresh = listed.filter((row) => changed.has(row.device_id))
    const previous = readCachedDevices()
    const kept = previous.filter((row) => !changed.has(row.device_id) && !removed.has(row.device_id))
    const rows = withProjectsRead(withDeviceProjects([...kept, ...fresh], projects, previous, projectsOf), null, previous, projectsOf)
    cache.set(rows)
    if (removed.size > 0) void desktopIpc()?.invoke(SERVER_SSH_MACHINES_CHANNELS.reconcile, { owner: userId, present: rows.map((row) => row.device_id) }).catch(() => undefined)
  }, [userId])
  useEffect(() => {
    if (!userId) return
    // The feed of `devices` (fresh: Infinity) starts here: starting over rows already held reads them once (what changed
    // while nobody listened, e.g. the shell was inactive); a read already on its way is that read.
    if (devicesModel.peek().state === 'value' && !devicesModel.isFetching()) void devicesModel.refresh()
    return subscribeAccountRevision('device_changed', (operations) => {
      // 只有可能牵动云电脑的那几条才去问管家:它自己那一行(睡下 / 醒来)、新出现或被移除的一台(开通 / 销毁)。
      // 别的电脑每 30 秒一次的心跳摘要 ❌ —— 忙账号六七台机器,每次心跳都多一发管家请求。
      const cloudDeviceId = knownCloudDeviceId()
      const known = new Set(readCachedDevices().map((row) => row.device_id))
      if (operations.some((operation) => {
        const key = readDeviceRevision(operation.payload)
        return key.removed || key.deviceId === cloudDeviceId || !known.has(key.deviceId)
      })) void cloudComputer.refresh()
      return applyDeviceRevisions(operations)
    })
  }, [userId, applyDeviceRevisions, subscribeAccountRevision])

  const rename = useCallback(async (deviceId: string, label: string) => {
    const ownerId = userId ?? cachedDevicesAccount()
    await chatService.renameDevice(deviceId, label)
    if (reportsToAssistant) await reportAssistantAppChange(appMachine, assistantKnown?.agentId ?? undefined, {
      resource: 'devices', operation: 'edited', id: deviceId, deviceId, after: { name: label },
    }, ownerId)
    await refresh()
  }, [refresh, reportsToAssistant, assistantKnown?.agentId, appMachine, userId])

  const remove = useCallback(async (deviceId: string, options: { cascade?: boolean } = {}) => {
    const ownerId = userId ?? cachedDevicesAccount()
    await chatService.removeDevice(deviceId, options)
    if (reportsToAssistant) await reportAssistantAppChange(appMachine, assistantKnown?.agentId ?? undefined, {
      resource: 'devices', operation: 'removed', id: deviceId, deviceId,
    }, ownerId)
    await refresh()
  }, [refresh, reportsToAssistant, assistantKnown?.agentId, appMachine, userId])

  // #6264 这台电脑用远程 SSH 添加的机器(清单随装上 / 移除一台跟着变):在不在线只看 SSH 设备连接(❌ 看咕咕云心跳),
  // 侧栏、选择器、设置 → 设备同一个说法。别的机器照常读心跳。
  const sshMachineIds = useSshMachineIds()
  const linkProblems = useSshLinkProblems()
  // #7199 云电脑那一行补上「休眠中 / 正在唤醒 / 运行中」,再排一次(休眠中的排在在线那一组)。
  const listedHere = useMemo(
    () =>
      sortDevices(
        withCloudComputerPresence(
          // SSH list not read yet (first run only: it is kept across restarts): each row shows its own cloud heartbeat (its value, not a default).
          sshMachineIds ? withSshLinkOnline(devices, sshMachineIds, linkProblems) : devices,
          cloudSnapshot,
          Date.now(),
          refused?.deviceId ?? null,
        ),
      ),
    [devices, sshMachineIds, linkProblems, cloudSnapshot, refused?.deviceId],
  )

  // #7199 手机(只被调动作,不是运行位置)单独一份:设置 → 设备列它,「在哪跑」、侧栏、各处机器选择只读 machines。
  // 在手机上,这台手机自己那一行标成本机。
  const { ios, deviceId: thisPhoneId } = usePhoneHostIdentity(userId)
  const { machines, phones } = useMemo(() => partitionPhones(ios ? listedHere.map(row => isPhoneDevice(row) ? { ...row, is_current_device: row.device_id === thisPhoneId } : row) : listedHere, thisPhoneId), [listedHere, thisPhoneId, ios])
  const directoryDevices = useMemo(() => [...machines, ...phones], [machines, phones])
  // 布局期发布:头像角标、收回着与否从这份读,首帧就要是这份,❌ 先画一帧旧的再翻。
  useLayoutEffect(() => { publishDirectoryDevices(directoryDevices) }, [directoryDevices])

  const listBoundAgents = useCallback(async (deviceId: string) => {
    return chatService.listAgentsOnDevice(deviceId)
  }, [])

  // A fresh value on every provider render re-rendered every device reader (sidebar, composer, contacts sections) even when
  // the render changed nothing they read.
  const value = useMemo(
    () => ({ devices: machines, phones, loading, error, refresh, rename, remove, listBoundAgents }),
    [machines, phones, loading, error, refresh, rename, remove, listBoundAgents],
  )
  return (
    <DevicesContext.Provider value={value}>
      {children}
    </DevicesContext.Provider>
  )
}
