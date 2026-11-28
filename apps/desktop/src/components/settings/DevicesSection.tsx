import { notifyCopied } from '@/lib/copyFeedback'
import { billingLinksAvailable } from '../../lib/appLinks'
import { refreshFailure, useReplica, type Reading, retryOf } from '../../lib/replica'
import { Unknown } from '../ui/Unknown'
import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isDeviceOnline } from '@gugu/core/shared/enums/deviceModels'
import type { Device } from '@gugu/core/shared/types/chat'
import { formatBytes, serverSupportsConfirmedRestart, type ServerMachineNotice } from '@gugu/core/cloud/serverMachineHealth'
import { REMOTE_TUNNEL_OPEN } from '@gugu/core/cloud/remoteTunnel'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { formatRelativeTime } from '../../lib/relativeTime'
import {
  deviceRowModel,
  canRestartServerUpdate,
  filterDevices,
  hasOtherMachines,
  type DeviceFilter,
  type DeviceRowModel,
} from '../../lib/deviceRowModel'
import { rendererLogger } from '../../lib/log'
import { useSshSignInStates } from '../../hooks/useSshSignInStates'
import { useSshLinkProblems, useSshUpgrades } from '../../hooks/useSshLinkProblems'
import { sshMachineAddresses, sshMachineIdsOf, watchSshMachineAddresses } from '../../lib/sshMachineAddresses'
import { sshLinkFacts, reportedSshUpdate } from '../../lib/sshLinkOnline'
import { disconnectSshDevice } from '../../lib/sshLinkChannel'
import { readServerVersionSwitchBusyAgents, retryServerVersionMatch, restartServerVersionNow, type VersionRestartResult } from '../../lib/serverVersionRetry'
import type { SshLinkFailure } from '../../lib/sshLink'
import type { SshSignInState } from '../../lib/serverSshMachines'
import { useDevicesStore } from '../../store/devicesContext'
import { platform } from '../../platform'
import { desktopIpc } from '../../platform/desktopIpc'
import { ChevronDown, ChevronRight, Monitor, Server, Smartphone, Copy, Pencil, Plus, RefreshCw, SquarePen, Trash2, Unplug } from '@/lib/icons'
import { canOpenNewSessionOnDevice, canReconnectDevice, openNewSessionOnDevice, reconnectDevice } from '../../lib/sessionpageNewSessionBridge'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu, MenuItem, MenuSeparator } from '../ui/Menu'
import { SearchField } from '../ui/SearchField'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { cn } from '../../lib/cn'
import { AddServerPanel, type AddServerMethod, type AddedServer } from './AddServerPanel'
import { InlineAction } from './addServer/InlineAction'
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages'
import { DeviceRecoveryPanel, type DeviceRecoveryProps } from './DeviceRecoveryPanel'
import { DeviceRecoveryStatus } from './DeviceRecoveryStatus'
import { supersededBy } from '../../lib/deviceSuperseded'
import { consumeAddServerIntent } from '../../lib/addServerIntent'
import { useSelect } from '../../lib/selectStore'
import { deviceRecoveryTarget, consumeDeviceActionsIntent } from '../../lib/deviceActionsIntent'
import { useDeviceRemoval } from './useDeviceRemoval'
import { SettingsGroup, SettingsNote, SettingsPage } from './SettingsPrimitives'
import { DeviceActionsPage } from './DeviceActionsPage'
import { deviceAcceptsWork } from '@gugu/core/cloud/cloudComputer'
import { withoutAssistantHome } from '../../lib/assistantHome'
import { deviceMachineFor, deviceMachines } from '@gugu/core/shared/deviceMachines'
import { useDeviceMachineSections } from '../../lib/deviceMachines'
import { DeviceMachineArchive } from '../devices/DeviceMachineArchive'
import { DeviceRenameField } from '../devices/DeviceRenameField'
import { useDeviceRename } from '../../hooks/useDeviceRename'
import { cloudSnapshotOf, useCloudComputer } from '../../lib/cloudComputer'

const log = rendererLogger('devices')

const DEVICE_LIST_CLASS = 'gg-settings-device-list'

export function DevicesSection({
  onUpgrade,
}: {
  /** #6264 添加机器碰到机器上限时句尾的「升级会员」:切到「设置 → 会员与额度」。 */
  onUpgrade?: () => void
} = {}) {
  const { t } = useTranslation('settings')
  const { toast } = useToast()
  const { devices: deviceRows, phones, loading, error, refresh, rename } = useDevicesStore()
  const cloudComputer = useCloudComputer()
  // Disk bytes are on-demand state; the revision journal only announces warning transitions.
  useEffect(() => { void refresh() }, [refresh])
  const allDevices = useMemo(() => [...deviceRows, ...(phones ?? [])], [deviceRows, phones])
  // #7199 个人助理住的那台云端宿主不在这一页(owner 10-15:用户看不到它住在哪);开通、叫醒、关闭都在「助理」App 里。
  const cloudDeviceId = cloudSnapshotOf(cloudComputer)?.deviceId ?? null
  const machines = useMemo(() => deviceMachines(withoutAssistantHome(allDevices, cloudDeviceId)), [allDevices, cloudDeviceId])
  const [inspectedEndpoint, setInspectedEndpoint] = useState<string | null>(null)
  const devices = useMemo(() => machines.map(machine =>
    machine.configurations.find(device => device.device_id === inspectedEndpoint) ?? machine.device
  ), [machines, inspectedEndpoint])
  // A reinstall or a new data directory leaves the old row behind: the online row that may have replaced it (a hint only).
  const replaced = useMemo(() => supersededBy(devices), [devices])
  const { addressOf, openRemove, openUninstall, openVersions, configurationActions, dialogs } = useDeviceRemoval(machines)

  const deviceRename = useDeviceRename()
  const canAddServer = desktopIpc() !== null
  // 从会话页新建框的「添加一台机器」进来时,直接把「选一种装法」的菜单打开(远程隧道没开放时只有一种,直接展开它)。
  const [addMenuFromIntent] = useState(() => consumeAddServerIntent() && canAddServer)
  // 正在用哪种装法添加(同一时间只展开一块)。
  const [addingServer, setAddingServer] = useState<AddServerMethod | null>(() =>
    addMenuFromIntent && !REMOTE_TUNNEL_OPEN ? 'ssh' : null
  )
  // #6264 设备行上点了「重新登录」的那台(经 SSH 走同一套装机流程;已装好的机器上就是只登录)。
  const [relogin, setRelogin] = useState<{ deviceId: string; address: string } | null>(null)
  const nameWhenAppears = useNameWhenAppears(devices, rename)
  const onServerAdded = useCallback((added: AddedServer) => {
    setAddingServer(null)
    if (added.deviceId && added.name) nameWhenAppears({ deviceId: added.deviceId, name: added.name })
  }, [nameWhenAppears])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<DeviceFilter>('all')
  // #7199 第二步:正在看哪台设备「能做的事」(设备页里的一个内页:点设备进它的连接应用页)。
  // #7199 助理主页点了一台设备 = 一进来就是那台的「能做的事」(deviceActionsIntent)。
  const [actionsFor, setActionsFor] = useState<string | null>(() => consumeDeviceActionsIntent())
  const actionsReturn = useRef<string | null>(null)
  useEffect(() => {
    if (!actionsFor && actionsReturn.current) {
      const row = document.getElementById(`settings-device-row-${actionsReturn.current}`)
      row?.querySelector<HTMLElement>('[data-device-permissions]')?.focus()
      actionsReturn.current = null
    }
  }, [actionsFor])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const recoveryTarget = useSelect(deviceRecoveryTarget, value => value)

  // 离线的 SSH 机器:问清是没开机 / 连不上,还是登录没了(照 VS Code Tunnels / Tailscale「Expired」)。
  const signIns = useSshSignInStates(devices, addressOf)
  // 远程 SSH 的机器:在线与否、要不要先登录,只看这台电脑到它的设备连接(与侧栏、顶上卡片同一个读数)。
  const linkProblems = useSshLinkProblems()
  const upgrades = useSshUpgrades()
  // SSH machines unreadable: said once above the list with a retry (❌ a placeholder forever).
  watchSshMachineAddresses()
  const sshMachines = useReplica(sshMachineAddresses, [])
  const sshMachineIds = sshMachines.state === 'value' ? sshMachineIdsOf(sshMachines.value) : null
  const showTools = hasOtherMachines(devices)
  const visible = useMemo(
    () => (showTools ? filterDevices(devices, { query, filter, sshAddress: addressOf }) : devices),
    [showTools, devices, query, filter, addressOf],
  )
  const { archived } = useDeviceMachineSections(machines)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const archivedIds = new Set(archived.flatMap(machine => machine.configurations.map(device => device.device_id)))
  const visibleActive = visible.filter(device => !archivedIds.has(device.device_id))
    .sort((a, b) => Number(b.is_current_device === true) - Number(a.is_current_device === true))
  const visibleArchived = visible.filter(device => archivedIds.has(device.device_id))
  useEffect(() => {
    if (!recoveryTarget) return
    if (loading || error) return
    const target = deviceMachineFor(machines, recoveryTarget)
    if (!target) {
      deviceRecoveryTarget.set(null)
      toast(t('devices.link.deviceGone'), 'info')
      return
    }
    if (actionsFor || filter !== 'all' || query || inspectedEndpoint !== recoveryTarget) {
      setActionsFor(null)
      setFilter('all')
      setQuery('')
      setInspectedEndpoint(recoveryTarget)
      return
    }
    if (!archiveOpen && archived.some(machine => machine.key === target.key)) {
      setArchiveOpen(true)
      return
    }
    const row = document.getElementById(`settings-device-row-${recoveryTarget}`)?.querySelector<HTMLButtonElement>('[data-testid="settings-device-summary"]')
    if (row) {
      setExpandedId(recoveryTarget)
      row.focus()
      deviceRecoveryTarget.set(null)
    }
  }, [recoveryTarget, actionsFor, filter, query, machines, inspectedEndpoint, loading, error, archived, archiveOpen, toast, t])
  const onlineCount = devices.filter((d) => deviceAcceptsWork(d)).length
  const filterItems = useMemo(() => [
    { value: 'all' as const, label: t('devices.filter.all', { n: devices.length }) },
    { value: 'online' as const, label: t('devices.filter.online', { n: onlineCount }) },
    { value: 'offline' as const, label: t('devices.filter.offline', { n: devices.length - onlineCount }) },
  ], [t, devices.length, onlineCount])

  const copyAddress = useCallback(async (address: string) => {
    try { await platform.writeClipboardText(address); notifyCopied(t('devices.copied')) }
    catch (error) { log.error({ error }, 'device address copy failed'); toast(t('actions.copyFailed', { ns: 'common' }), 'error', messageForUser(error)) }
  }, [toast, t])

  const actionsMachine = deviceMachineFor(machines, actionsFor)
  const actionsDevice = actionsMachine?.device
  if (actionsDevice) {
    return <><DeviceActionsPage device={actionsDevice} configurations={actionsMachine?.configurations}
      configurationActions={configurationActions}
      isThisDevice={actionsDevice.is_current_device === true} onBack={() => setActionsFor(null)} />{dialogs}</>
  }

  const renderRow = (device: Device) => (
    <DeviceRow
      key={device.device_id}
      expanded={expandedId === device.device_id}
      onExpand={open => setExpandedId(open ? device.device_id : null)}
      device={device}
      configurationCount={deviceMachineFor(machines, device.device_id)!.configurations.length}
      model={deviceRowModel(device, addressOf(device.device_id), cloudDeviceId)}
      editing={deviceRename.editingId === device.device_id}
      renameFailed={deviceRename.failedFor(device.device_id)}
      onStartRename={() => deviceRename.start(device)}
      onCommitRename={(next) => void deviceRename.save(device, next)}
      onCancelRename={deviceRename.cancel}
      onCopyAddress={(address) => void copyAddress(address)}
      onRemove={() => openRemove(device)}
      onRemoveVersions={() => openVersions(device)}
      replacedBy={replaced.get(device.device_id) ?? null}
      onUninstall={() => openUninstall(device)}
      onOpenActions={() => { actionsReturn.current = device.device_id; setActionsFor(device.device_id) }}
      signIn={signIns.get(device.device_id) ?? null}
      sshLink={sshMachines.state === 'unknown' ? 'unknown' : sshMachineIds?.has(device.device_id) ? (linkProblems.has(device.device_id) ? linkProblems.get(device.device_id) : 'checking') : undefined}
      upgradePercent={upgrades.get(device.device_id) ?? null}
      onRetryVersionMatch={() => retryServerVersionMatch(device.device_id)}
      onRestartVersionNow={(version) => restartServerVersionNow(device.device_id, version, serverSupportsConfirmedRestart(device.capabilities))}
      onRelogin={canAddServer && addressOf(device.device_id)
        ? () => {
            setRelogin({ deviceId: device.device_id, address: addressOf(device.device_id)! })
            setAddingServer('ssh')
          }
        : undefined}
    />
  )

  return (
    <SettingsPage data-testid={AUTOMATION_TEST_IDS.settingsDevicesPane}>

      {addingServer && (
        <AddServerPanel
          key={relogin?.deviceId ?? 'add'}
          method={addingServer}
          onMethodChange={setAddingServer}
          onClose={() => { setAddingServer(null); setRelogin(null) }}
          onAdded={(added) => { setRelogin(null); onServerAdded(added) }}
          onUpgrade={billingLinksAvailable() ? onUpgrade : undefined}
          relogin={relogin ?? undefined}
        />
      )}

      {error && (
        <SettingsNote tone="danger">
          {t('devices.listFailed')}
          <Button variant="ghost" size="sm" onClick={() => void refresh()} style={{ marginLeft: 'var(--spacing-sm)' }}>{t('devices.retry')}</Button>
        </SettingsNote>
      )}

      {refreshFailure(sshMachines) && (
        <SettingsNote tone="danger">
          {t('devices.sshListFailed')}
          <Button variant="ghost" size="sm" onClick={retryOf(sshMachines)} className="ml-2">{t('devices.retry')}</Button>
        </SettingsNote>
      )}

      {loading && devices.length === 0 && <SettingsNote>{t('devices.loading')}</SettingsNote>}

      {(showTools || (canAddServer && !addingServer)) && (
        <div className="gg-device-tools" data-testid="settings-devices-tools">
          {showTools && <SearchField
            className="min-w-0 flex-1"
            value={query}
            placeholder={t('devices.search')}
            onChange={(e) => setQuery(e.currentTarget.value)}
            clearLabel={t('devices.cancel')}
            onClear={() => setQuery('')}
            data-testid="settings-devices-search"
          />}
          {canAddServer && !addingServer && <AddServerButton defaultOpen={addMenuFromIntent} onPick={setAddingServer} />}
        </div>
      )}
      {showTools && <SegmentedTabs items={filterItems} value={filter} onChange={setFilter} variant="underline" ariaLabel={t('devices.filter.label')} />}
      {(visibleActive.length > 0 || visibleArchived.length > 0) && <SettingsGroup>
        <div className={cn(DEVICE_LIST_CLASS, visibleActive.length === 0 && 'hidden')} role="list">
          {visibleActive.map(renderRow)}
        </div>
        <DeviceMachineArchive expanded={archiveOpen} onExpand={setArchiveOpen} count={visibleArchived.length} listClassName={DEVICE_LIST_CLASS}>{visibleArchived.map(renderRow)}</DeviceMachineArchive>
      </SettingsGroup>}
      {!showTools && !addingServer && <SettingsNote data-testid="settings-devices-empty">{t('devices.empty.hint')}</SettingsNote>}

      {showTools && visible.length === 0 && (
        <div className="text-[length:var(--font-body)] text-[var(--muted-fg)]" data-testid="settings-devices-no-match">{t('devices.noMatch')}</div>
      )}

      {dialogs}

    </SettingsPage>
  )
}

function AddServerButton({ onPick, defaultOpen }: {
  onPick: (method: AddServerMethod) => void
  defaultOpen: boolean
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(defaultOpen)
  // Picking an installer transfers focus to its form. Dismissing the menu returns to Add.
  const pickedRef = useRef(false)
  const trigger = <Button data-testid="settings-add-server-button" onClick={REMOTE_TUNNEL_OPEN ? undefined : () => onPick('ssh')}>
    <Plus size={15} />{t('devices.addServer.open')}
  </Button>
  if (!REMOTE_TUNNEL_OPEN) return trigger
  const item = (method: AddServerMethod) => (
    <MenuItem data-testid={`settings-add-server-${method}`} onClick={() => { pickedRef.current = true; onPick(method) }}>
      <span className="flex flex-col gap-[2px]">
        <span className="text-[var(--fg)]">{t(`devices.addServer.method.${method}`)}</span>
        <span className="text-[length:var(--font-caption)] leading-[1.4] whitespace-normal text-[var(--muted-fg)]">
          {t(`devices.addServer.method.${method}Hint`)}
        </span>
      </span>
    </MenuItem>
  )
  return (
    <DropdownMenu.Root open={open} modal={false} onOpenChange={(next) => { if (next) pickedRef.current = false; setOpen(next) }}>
      <DropdownMenu.Trigger aria-haspopup="menu" render={trigger} />
      {open && (
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          zIndex="var(--z-settings-modal)"
          aria-label={t('devices.addServer.method.label')}
          className="w-[320px]"
          finalFocus={() => !pickedRef.current}
        >
          {item('ssh')}
          {item('tunnel')}
        </DropdownMenu.Content>
      )}
    </DropdownMenu.Root>
  )
}

/** 等多久:装好到它自己上线注册,通常几秒;一分钟还没出现就不等了(名字随时能在「⋯」里改)。 */
const NAME_WAIT_MS = 60_000

/**
 * 从 ~/.ssh/config 挑别名装上的新机器,默认就叫那个别名:装好时它可能还没出现在列表里,
 * 所以记下「这台叫什么」,等它出现就改一次名。添加那一块已经收起了,这件事由设备页接着做完。
 * 改名失败只记日志 —— 行上照常是默认名,随时能改。
 */
function useNameWhenAppears(devices: readonly Device[], rename: (deviceId: string, label: string) => Promise<void>) {
  const [pending, setPending] = useState<{ deviceId: string; name: string } | null>(null)
  const started = useRef<string | null>(null)
  const target = pending ? devices.find((d) => d.device_id === pending.deviceId) ?? null : null
  const targetLabel = target?.label ?? null

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setPending((current) => (current === pending ? null : current)), NAME_WAIT_MS)
    return () => clearTimeout(timer)
  }, [pending])

  useEffect(() => {
    if (!pending || targetLabel === null) return
    if (targetLabel === pending.name) { setPending(null); return }
    if (started.current === pending.deviceId) return
    started.current = pending.deviceId
    rename(pending.deviceId, pending.name).then(
      () => setPending(null),
      (err: unknown) => {
        log.error({ err: String((err as Error)?.message ?? err), deviceId: pending.deviceId }, 'name new server failed')
        setPending(null)
      },
    )
  }, [pending, targetLabel, rename])

  return useCallback((next: { deviceId: string; name: string }) => {
    started.current = null
    setPending(next)
  }, [])
}

/**
 * 「可能已被「B」顶替」(owner 10-28): the row that may have replaced this one, and its removal (the usual confirmation).
 * Why it says so is on hover — and a press opens it under the line, for a phone, which has no hover.
 */
function ReplacedHint({ by, onRemove }: { by: Device; onRemove: () => void }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const why = t('devices.replaced.why', { name: by.label })
  return (
    <div className="mt-[3px] text-[length:var(--font-caption)] text-[var(--muted-fg)]" data-testid="settings-device-replaced">
      <Button
        variant="ghost"
        title={why}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline h-auto min-h-0 max-[719px]:min-h-0 border-0 p-0 align-baseline text-left text-[length:inherit] leading-[inherit] font-[inherit] text-[var(--muted-fg)] underline decoration-dotted underline-offset-2 [&:hover:not([data-disabled])]:bg-transparent"
        data-testid="settings-device-replaced-hint"
      >
        {t('devices.replaced.hint', { name: by.label })}
      </Button>
      {' '}<InlineAction onClick={onRemove} testId="settings-device-replaced-remove">{t('devices.replaced.remove')}</InlineAction>
      {open && <div className="mt-[3px] leading-[1.5]" data-testid="settings-device-replaced-why">{why}</div>}
    </div>
  )
}

function DeviceRow({
  expanded, onExpand,
  device,
  model,
  configurationCount,
  editing,
  renameFailed,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onCopyAddress,
  onRemove,
  onRemoveVersions,
  replacedBy,
  onUninstall,
  onOpenActions,
  signIn,
  sshLink,
  upgradePercent,
  onRetryVersionMatch,
  onRestartVersionNow,
  onRelogin,
}: {
  expanded: boolean
  onExpand: (open: boolean) => void
  device: Device
  model: DeviceRowModel
  configurationCount: number
  editing: boolean
  renameFailed: string
  onStartRename: () => void
  onCommitRename: (next: string) => void
  onCancelRename: () => void
  onCopyAddress: (address: string) => void
  onRemove: () => void
  /** ≥2 个版本时的「移除」:打开版本列表,逐个移除(当前这台除外)。 */
  onRemoveVersions: () => void
  /** The online row this one may have been replaced by (lib/deviceSuperseded): said, with a way to remove it. */
  replacedBy: Device | null
  onUninstall: () => void
  /** #7199 这台设备能做的事(能被助理调用的动作)。 */
  onOpenActions: () => void
  /** 离线的 SSH 机器上这个账号还登着没有(问不到 = null / unknown,照旧只说离线)。 */
  signIn: Reading<SshSignInState> | null
  /** #6264 远程 SSH 那台此刻设备连接的问题(没有 = 连着);其它机器 null。 */
  /** Its SSH link from this desktop; undefined = not an SSH machine here; 'unknown' = the SSH machine list is not read yet. */
  sshLink?: SshLinkFailure | null | 'unknown' | 'checking'
  /** 正在替它升级时的进度百分比(不知道总量 = null)。 */
  upgradePercent?: number | null
  /** #6264 那台机器换成和桌面匹配的版本没成(心跳报 server_update.failed):请它再试一次。 */
  onRetryVersionMatch?: () => Promise<boolean>
  onRestartVersionNow?: (version: string) => Promise<VersionRestartResult>
  /** 经 SSH 重新登录(只有这台桌面记着怎么 SSH 过去的机器有)。 */
  onRelogin?: () => void
}) {
  const { t } = useTranslation('settings')
  const { toast } = useToast()
  const { translate } = useSessionMessages()
  const [menuOpen, setMenuOpen] = useState(false)
  // 「改名」同「添加一台机器」:选中后菜单入口随即卸掉、改名框自己接焦点,菜单关上时❌ 再归还焦点(理由见 AddServerButton)。
  const renamingRef = useRef(false)
  const sshAddress = model.connection.via === 'ssh' ? model.connection.address : null
  const lastSeen = formatRelativeTime(device.last_seen_at, { mode: 'elapsed', dateAfterDays: 30 })
  // 「登录已失效」「那台机器上已退出登录」替掉「上次在线」:机器是离线的,但真正的原因是这个,下一步是重新登录。
  const link = sshLink === undefined || sshLink === 'unknown' || sshLink === 'checking' ? null : sshLinkFacts(true, reportedSshUpdate(device, sshLink), device.is_online).sshLink ?? null
  // 点了「重试」、那台机器的心跳还没报回新状态之前:先说「正在更新」;报回来(不再是这一次失败)就让位给它。
  const failedUpdate = device.is_online && model.update?.state === 'failed' ? model.update.version : null
  const [retriedFor, setRetriedFor] = useState<string | null>(null)
  const retrying = failedUpdate !== null && retriedFor === failedUpdate
  // 「有新版本」在等空闲:人可以「现在重启更新」(先说清会中断正在跑的 agent,再点一次才发)。
  // 这里只记这次当面提问,以及它的请求是不是还在路上;「正在重启」只读那台机器自己报的事实(下面 restarting),❌ 在页面里另记一份。
  const [asking, setAsking] = useState<{ busyAgents: number | null | undefined; sending?: true } | null>(null)
  const askRestart = () => {
    const question = { busyAgents: null }
    setAsking(question)
    void readServerVersionSwitchBusyAgents(device.device_id).then(busyAgents => {
      setAsking(current => current === question ? { ...question, busyAgents } : current)
    })
  }
  // Legacy and installation-wide hosts share the same explicit restart action.
  const canRestart = canRestartServerUpdate(model.update, device.capabilities)
  // 起不来的那一版只有确认重启能再试(普通「重试」解不开它的冷却):失败行给「现在重启更新」,❌ 给一颗按了没用的「重试」。
  const bootFailed = model.update?.state === 'failed' && model.update.reason === 'boot-failed'
  // 只问够得着的机器:设备连接在重连(那台 server 正在退出 / 起来)时,请求到不了它。
  const restartable = device.is_online && (!link || link === 'waitingIdle' || link === 'confirmationRequired' || link === 'updateFailed') && canRestart && (model.update?.state === 'ready' || bootFailed)
  const outcome = device.capabilities.server_update_outcome ?? model.update?.lastOutcome
  // 正在重启 = 那台机器报着一次已接下、还没有结果的确认重启,而且它跑的还不是这次要换到的那一版。
  // 报上来的版本已经是目标版本 = 已经换过去了:新版本启动完写下结果之前,❌ 还说「正在重启」。
  const restarting = outcome?.kind === 'waiting' && !!model.update && model.update.version !== model.version
  if (asking && !asking.sending && !restartable) setAsking(null)
  const signInState = signIn?.state === 'value' ? signIn.value : null
  // 离线的 SSH 机器还没问到登录态:状态那一格画占位,❌ 先写「N 天前在线」再改成「登录已失效」。
  // Not known yet whether it is an SSH machine here (the list is not read): the same placeholder, ❌ "seen N days ago".
  const signInPending = !device.is_online && sshLink !== 'notSignedIn' && (signIn?.state === 'unknown' || sshLink === 'unknown')
  const signedOutText = sshLink === 'notSignedIn'
    ? t('devices.loginState.signedOut')
    : device.is_online || !signInState
    ? null
    : signInState.state === 'expired'
      ? t('devices.loginState.expired', { time: formatRelativeTime(signInState.at, { mode: 'elapsed', dateAfterDays: 30 }) })
      : signInState.state === 'signedOut' || signInState.state === 'removed'
        ? t('devices.loginState.signedOut')
        : null
  const version = model.kind === 'cloud'
    ? null
    : model.version
      ? t(model.kind === 'server' ? 'devices.serverVersion' : 'devices.appVersion', { version: model.version })
      : t('devices.versionUnknown')
  const summaryRef = useRef<HTMLButtonElement>(null)
  const focusedDetail = useRef<Element | null>(null)
  useLayoutEffect(() => {
    // Recovery can replace a focused action when the device reports its next state.
    if (focusedDetail.current && !focusedDetail.current.isConnected) {
      focusedDetail.current = null
      if (expanded && document.activeElement === document.body) summaryRef.current?.focus()
    }
  })
  useEffect(() => {
    if (!editing && renamingRef.current) {
      renamingRef.current = false
      if (document.activeElement === document.body) summaryRef.current?.focus()
    }
  }, [editing])
  const ssh = !!sshAddress || (sshLink !== undefined && sshLink !== 'unknown')
  const recovery: DeviceRecoveryProps['state'] = link ?? (signedOutText ? 'notSignedIn' : sshLink === 'checking' ? 'checking'
    : isDeviceOnline(device.status) && model.update?.state === 'ready' ? 'waitingIdle'
    : isDeviceOnline(device.status) && (model.update?.state === 'downloading' || model.update?.state === 'switching') ? 'updating'
    : isDeviceOnline(device.status) && failedUpdate ? 'updateFailed' : 'connected')
  const connection = model.connection.via
  const kind = t(`devices.kind.${model.kind}`)
  const method = ssh || connection === 'sshElsewhere' ? t('devices.addServer.method.ssh')
    : model.kind === 'server' && connection === 'cloud' ? t('devices.via.tunnel') : null
  const summaryMeta = method ? [model.system, method] : [model.kind === 'this' ? t('devices.current') : kind, model.system]
  const reportedStatus = restarting ? t('devices.update.restarting')
    : device.is_online && model.update?.state === 'failed' ? t(retrying ? 'devices.loginState.matchRetrying' : 'devices.loginState.matchFailed')
    : device.is_online && model.update?.state === 'ready' ? t('devices.update.ready')
    : device.is_online && (model.update?.state === 'downloading' || model.update?.state === 'switching') ? t('devices.recovery.updating.status') : null
  const bootFailures = device.capabilities.server_boot_failures ?? []
  const attention = bootFailures.length > 0 || !!replacedBy
  const rowStatus = reportedStatus ?? signedOutText ?? (attention ? t('devices.facts.attention')
    : !device.is_online && lastSeen ? t('devices.lastSeen', { time: lastSeen })
    : t(device.is_online ? 'devices.online' : 'devices.offline'))
  const closeDetails = () => {
    onExpand(false)
    summaryRef.current?.focus()
  }
  const RowIcon = model.kind === 'phone' ? Smartphone : model.kind === 'server' ? Server : Monitor
  const detailsId = `device-recovery-${device.device_id}`
  const acceptsWork = deviceAcceptsWork(device)
  const supervisorReady = model.update?.scope === 'supervisor' && model.update.state === 'ready'
  const hasBusyTasks = typeof model.update?.busy_agents === 'number' && model.update.busy_agents > 0
  const readyText = supervisorReady
    ? t('devices.update.supervisorReady', { version: model.update?.version })
    : t(hasBusyTasks ? 'devices.update.readyCount' : 'devices.update.ready', { count: model.update?.busy_agents })

  const managementMenu = (
    <DropdownMenu.Root
      open={menuOpen}
      modal={false}
      onOpenChange={(open) => { if (open) renamingRef.current = false; setMenuOpen(open) }}
    >
      <DropdownMenu.Trigger
        data-testid="settings-device-menu-button"
        aria-haspopup="menu"
        render={<Button size="sm" variant="ghost">{t('devices.actions')}<ChevronDown size={12} /></Button>}
      />
      {menuOpen && (
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={4}
          zIndex="var(--z-settings-modal)"
          className="min-w-[200px]"
          finalFocus={() => !renamingRef.current}
        >
          <MenuItem
            data-testid={AUTOMATION_TEST_IDS.settingsDeviceRenameButton}
            icon={<Pencil size={16} />}
            onClick={() => { renamingRef.current = true; onStartRename() }}
          >
            {t('devices.menu.rename')}
          </MenuItem>
          {model.kind !== 'this' && model.kind !== 'cloud' && acceptsWork && !link && canOpenNewSessionOnDevice() && (
            <MenuItem data-testid="settings-device-new-session" icon={<SquarePen size={16} />} onClick={() => openNewSessionOnDevice(device.device_id)}>
              {t('devices.addServer.newTask')}
            </MenuItem>
          )}
          {model.kind !== 'this' && model.kind !== 'cloud' && device.is_online && !link && canReconnectDevice() && (
            <MenuItem data-testid="settings-device-reconnect" icon={<RefreshCw size={16} />} onClick={() => reconnectDevice(device.device_id)}>
              {t('devices.menu.reconnect')}
            </MenuItem>
          )}
          {sshAddress && sshLink === null && (
            <MenuItem icon={<Unplug size={16} />} data-testid="settings-device-ssh-disconnect" onClick={() => {
              void disconnectSshDevice(device.device_id).catch(error => toast(t('devices.link.disconnectFailed'), 'error', messageForUser(error)))
            }}>{translate('remoteHost.ssh.disconnect')}</MenuItem>
          )}
          {sshAddress && (
            <MenuItem data-testid="settings-device-copy-address" icon={<Copy size={16} />} onClick={() => onCopyAddress(sshAddress)}>
              {t('devices.menu.copyAddress')}
            </MenuItem>
          )}
          {configurationCount > 1 && (
            <>
              <MenuSeparator />
              <MenuItem danger data-testid="settings-device-remove-versions" icon={<Unplug size={16} />} onClick={onRemoveVersions}>
                {t('devices.menu.removeVersions')}
              </MenuItem>
            </>
          )}
          {model.kind !== 'this' && configurationCount === 1 && (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                data-testid={AUTOMATION_TEST_IDS.settingsDeviceRemoveButton}
                icon={<Unplug size={16} />}
                onClick={onRemove}
              >
                {t('devices.menu.remove')}
              </MenuItem>
              {sshAddress && model.kind === 'server' && (
                <MenuItem danger data-testid="settings-device-uninstall-button" icon={<Trash2 size={16} />} onClick={onUninstall}>
                  {t('devices.menu.uninstall')}
                </MenuItem>
              )}
            </>
          )}
        </DropdownMenu.Content>
      )}
    </DropdownMenu.Root>
  )

  const facts = <>
    {model.kind !== 'this' && <><dt>{t('devices.facts.connection')}</dt><dd>
      {connection === 'sshElsewhere' ? t('devices.via.sshElsewhereHint') : (connection === 'cloud' && model.kind === 'server' ? t('devices.via.tunnelHint') : method) ?? (connection === 'unknown' ? <Unknown className="w-24" /> : kind)}
      {sshAddress && <> · {sshAddress} <IconButton size="sm" aria-label={t('devices.menu.copyAddress')} onClick={() => onCopyAddress(sshAddress)}><Copy size={13} /></IconButton></>}
    </dd></>}
    {version && <><dt>{t('devices.recovery.version')}</dt><dd>{version}</dd></>}
    {lastSeen && <><dt>{t('devices.facts.lastOnline')}</dt><dd>{lastSeen}</dd></>}
    {configurationCount > 1 && <><dt>{t('devices.configurations')}</dt><dd data-testid="settings-device-version-count">{t('devices.configurationCount', { count: configurationCount })}</dd></>}
    {device.capabilities.runs_as_root && <><dt>{t('devices.facts.runsAs')}</dt><dd title={t('devices.runsAsRootHint')} data-testid="settings-device-runs-as-root">{t('devices.runsAsRoot')}</dd></>}
    {model.notices.length > 0 && <><dt>{t('devices.facts.notices')}</dt><dd>{model.notices.map(n => <DeviceNotice key={n.kind} notice={n} />)}</dd></>}
  </>
  return (
    <div role="listitem" id={`settings-device-row-${device.device_id}`} data-testid={AUTOMATION_TEST_IDS.settingsDeviceRow}
      data-device-id={device.device_id} data-kind={model.kind} className="gg-settings-device-row"
      onKeyDown={event => {
        if (expanded && !editing && !menuOpen && event.key === 'Escape' && !event.defaultPrevented && event.currentTarget.contains(event.target as Node)) {
          event.stopPropagation()
          closeDetails()
        }
      }}>
      {editing ? <DeviceRenameField label={device.label} onSave={onCommitRename} onCancel={onCancelRename} /> : (
        <Button ref={summaryRef} variant="ghost" className="gg-device-summary" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined}
          onClick={() => onExpand(!expanded)} data-testid="settings-device-summary">
          <RowIcon size={18} aria-hidden />
          <span className="gg-device-identity"><strong>{device.label}</strong>
            <small data-testid="settings-device-kind">{summaryMeta.filter(Boolean).join(' · ')}</small></span>
          {ssh && (!attention || recovery !== 'connected') ? <DeviceRecoveryStatus deviceId={device.device_id} state={recovery} /> :
            signInPending && !attention && !reportedStatus ? <Unknown className="w-24" /> : (
            <span role="status" className="gg-recovery-status" data-state={attention || signedOutText || failedUpdate ? 'attention' : device.is_online ? 'connected' : 'offline'}>
              <i aria-hidden="true" />{rowStatus}
            </span>)}
          <ChevronRight className="gg-device-chevron" size={14} aria-hidden />
        </Button>
      )}
      {expanded && !editing && <div id={detailsId} className="gg-device-expanded"
        onFocusCapture={event => { focusedDetail.current = event.target }}
        onBlurCapture={event => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusedDetail.current = null
        }}>
        {bootFailures.map((failure) => (
          <div key={`${failure.operation}:${failure.taskId}`} role="alert" className="mt-1 text-[length:var(--font-caption)] text-[var(--danger-fg)]" data-testid="settings-device-boot-failure">
            {t('devices.bootTaskFailed', { task: failure.taskId, operation: failure.operation, message: failure.message })}
          </div>
        ))}

        {replacedBy && <ReplacedHint by={replacedBy} onRemove={onRemove} />}
        {ssh ? <DeviceRecoveryPanel key={device.device_id + recovery} deviceId={device.device_id} state={recovery} name={device.label}
          version={model.version} address={sshAddress} progress={upgradePercent} onDone={closeDetails} listFacts={facts} /> : <>
          {(model.update || signedOutText) && <div className="gg-device-update">
            {restarting && <span data-testid="settings-device-restarting">{t('devices.update.restarting')}</span>}
            {!restarting && (model.update?.state === 'ready' || model.update?.state === 'downloading') && (
              <span
                title={supervisorReady ? readyText : t(model.update.state === 'ready' ? 'devices.update.readyHint' : 'devices.update.downloadingHint', { version: model.update.version })}
                data-testid="settings-device-update"
              >
                {model.update.state === 'ready'
                  ? readyText
                  : t('devices.update.downloading', { version: model.update.version })}
              </span>
            )}
            {restartable && model.update?.state === 'ready' && !restarting && onRestartVersionNow && asking === null && (
              <Button size="sm" onClick={askRestart} data-testid="settings-device-update-now">{t('devices.update.updateNow')}</Button>
            )}
            {restartable && onRestartVersionNow && asking && (
              <div className="mt-[6px] flex flex-wrap items-center gap-2" data-testid="settings-device-update-now-confirm">
                <span className="min-w-0 flex-1 text-[length:var(--font-caption)] text-[var(--muted-fg)]">{t(typeof asking.busyAgents === 'number' ? 'devices.update.updateNowConfirmCount' : 'devices.update.updateNowConfirm', { name: device.label, count: asking.busyAgents ?? undefined })}</span>
                <Button size="sm" disabled={asking.sending} onClick={() => setAsking(null)} data-testid="settings-device-update-now-no">{t('devices.cancel')}</Button>
                <Button size="sm" variant="primary" disabled={asking.busyAgents === null || asking.sending} onClick={() => {
                  if (!model.update) return
                  const sending = { ...asking, sending: true as const }
                  setAsking(sending)
                  const done = () => setAsking(current => current === sending ? null : current)
                  const failed = (error?: unknown) => {
                    done()
                    toast(t('devices.update.restartFailed', { name: device.label }), 'error', error ? messageForUser(error) : undefined)
                  }
                  void onRestartVersionNow(model.update.version).then(result => result.requested ? done() : failed(), failed)
                }} data-testid="settings-device-update-now-yes">
                  {t('devices.update.confirmRestart')}
                </Button>
              </div>
            )}
            {failedUpdate !== null && (
              <span className={retrying || restarting ? undefined : 'text-[var(--danger-fg)]'} data-testid="settings-device-match-failed">
                {retrying || restarting ? t('devices.loginState.matchRetrying') : t('devices.loginState.matchFailed')}
                {!retrying && !restarting && bootFailed && restartable && onRestartVersionNow && asking === null && (
                  <>{' '}<InlineAction onClick={askRestart} testId="settings-device-match-restart-now">{t('devices.update.updateNow')}</InlineAction></>
                )}
                {!retrying && !bootFailed && onRetryVersionMatch && (
                  <>{' '}<InlineAction
                    onClick={() => {
                      setRetriedFor(failedUpdate)
                      // 一分钟后还报同一次失败(又没成)= 重新给「重试」;心跳 30 秒一次,够它报回「正在下载」。
                      const reset = () => setRetriedFor((current) => (current === failedUpdate ? null : current))
                      const failed = (error?: unknown) => {
                        reset()
                        toast(t('devices.loginState.matchFailed'), 'error', error ? messageForUser(error) : undefined)
                      }
                      void onRetryVersionMatch().then((ok) => (ok ? void setTimeout(reset, 60_000) : failed()), failed)
                    }}
                    testId="settings-device-match-retry"
                  >{t('devices.loginState.retryUpdate')}</InlineAction></>
                )}
              </span>
            )}
            {signedOutText && <span data-testid="settings-device-signed-out">{signedOutText}</span>}
            {signedOutText && onRelogin && <InlineAction onClick={onRelogin} testId="settings-device-relogin">{t('devices.loginState.relogin')}</InlineAction>}
          </div>}
          <dl className="gg-device-facts">{facts}</dl>
        </>}
        <div className="gg-device-foot">
          <Button variant="ghost" size="sm" data-device-permissions="" data-testid={model.kind === 'this' ? 'settings-device-actions-entry' : 'settings-device-open-actions'} onClick={onOpenActions}>
            {t(model.kind === 'this' ? 'devices.deviceActions.entryTitle' : 'devices.facts.actions')}<ChevronRight size={12} />
          </Button>
          {managementMenu}
        </div>
      </div>}
      {renameFailed && <p role="alert" className="text-[var(--danger-fg)]">{renameFailed}</p>}
    </div>
  )
}

/**
 * The notice names the condition; its title gives the consequence and recovery.
 * 版本对不上、磁盘快满会让操作失败 → warn;升级被退回已经自愈,只是告知 → default。
 */
function DeviceNotice({ notice }: { notice: ServerMachineNotice }) {
  const { t } = useTranslation('settings')
  switch (notice.kind) {
    case 'desktop-too-old':
      return <span className="gg-device-notice" title={t('devices.notice.desktopTooOldHint')} data-testid="settings-device-notice">{t('devices.notice.desktopTooOld')}</span>
    case 'server-too-old':
      return <span className="gg-device-notice" title={t('devices.notice.serverTooOldHint')} data-testid="settings-device-notice">{t('devices.notice.serverTooOld')}</span>
    case 'disk-low':
      return (
        <span className="gg-device-notice" title={t('devices.notice.diskLowHint', { free: formatBytes(notice.freeBytes) })} data-testid="settings-device-notice">
          {t('devices.notice.diskLow')}
        </span>
      )
    case 'rolled-back':
      return (
        <span title={t('devices.notice.rolledBackHint', { version: notice.version, restored: notice.restored })} data-testid="settings-device-notice">
          {t('devices.notice.rolledBack')}
        </span>
      )
  }
}
