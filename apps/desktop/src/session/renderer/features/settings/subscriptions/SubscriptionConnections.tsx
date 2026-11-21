import { SubscriptionModelRows, SubscriptionAccountField } from '@/components/settings/SubscriptionModelRows'
import { metadataSeparator } from '@/i18n/format'
import { Unknown } from '@/components/ui/Unknown';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ChevronDown, MoreHorizontal, Plus } from '@/lib/icons'
import { useMutation } from '@tanstack/react-query'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import { type AgentPayload } from '@shared/core/agents/agent-payload'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { onMachineEvent } from '@renderer/lib/ipc'
import { subscriptionSwitchProgressChannel } from '@shared/core/sessions/subscriptionSwitchEvents'
import { useShowModal } from '@renderer/lib/modal/modal-provider'
import { Button } from '@renderer/lib/ui/button'
import { SelectItem } from '@renderer/lib/ui/select'
import { AgentHomeRow } from './AgentHomeRow'
import { ConnectionSettingsRows } from './ConnectionSettingsRows'
import { Input } from '@renderer/lib/ui/input'
import {
  Dialog,
  DialogContent,
  DialogContentArea,
  DialogHeader,
  DialogTitle
} from '@renderer/lib/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@renderer/lib/ui/dropdown-menu'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { useLibraryHost } from '@renderer/features/library/library-host'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { forceRefreshHarnessModelCatalog } from '@renderer/lib/stores/use-harness-model-catalog'
import { harnessModelCredential } from '@renderer/lib/stores/agent-replicas'
import { resolveSignInMethod } from '../agents-page/agent-account'
import { useAgentSignIn } from '../agents-page/use-agent-sign-in'
import { dropIfNeverSignedIn } from './drop-unsigned-connection'
import { rendererLogger } from '@/lib/log'
import { refreshTag } from '@/lib/replica'
import type { SubscriptionUsageWindow } from '@gugu/session-core/agents/plugins'
import {
  ConnectionActionError,
  errorText,
  sessionsBusyOf,
  SUBSCRIPTIONS,
  useSubscriptionUsage
} from './subscription-queries'
import { NEARLY_USED_PERCENT, payerLine, windowLabel } from './subscription-view'
import { nativeConfigured, useConnectionDetails, useListedConnections } from './listed-connections'
import { SwitchNoticeLine } from './SwitchNoticeLine'
import './subscriptions.css'

/**
 * 切换没成时给行摆的一句话。`gentle`=被拒而不是出错(有会话正在工作),不飘红。
 * `closeAndSwitch`:被拒时的出路 —— 一键把正在工作的会话也关掉、接着切(额度用完时它们本来也跑不下去)。
 * `progress`:点了之后正在关 —— 关完几个 / 一共几个;`null` = 主进程还没报第一次。
 */
export type SwitchNotice = {
  tone: 'gentle' | 'error'
  text: string
  closeAndSwitch?: () => void
  progress?: { closed: number; total: number } | null
}

/**
 * 「添加连接」里的「账号」是哪一种:
 *  · `connection` —— Claude / Codex:另起一个账号连接、各自登录(多账号);
 *  · `cli` —— 其余能在咕咕里登录的家:登它 CLI 自己那一份,登上后它就是「现有 CLI 配置」。
 */
type AccountMethod = 'connection' | 'cli' | null

/**
 * `onError` 把切换失败的原因交给行去摆(整行宽度);这里只管菜单与按钮,❌ 在窄的操作列里画长句。
 *
 * 只列真有东西的连接(`useListedConnections`)。一个都没有时只有「添加连接」,点了直接是表单,❌「切换连接 ▾」
 * 下拉里摆一个空的「现有 CLI 配置」(owner 2026-11-12)。表单依照各家的账号与厂商 Key 声明。
 */
export function SubscriptionConnections({
  agent,
  machine,
  onError,
  trigger,
  label,
  open: requestedOpen,
  onOpenChange,
  anchor,
  settingsRows = false,
  embedded = false,
  modelRows,
  modelAccount,
  signInRequested,
  description
}: {
  modelRows?: boolean
  modelAccount?: { onClose: () => void; onBusyChange?: (busy: boolean) => void }
  /** A fresh object is created only by an explicit press on the transcript's expired-login action. */
  signInRequested?: object
  settingsRows?: boolean
  /** 嵌在订阅页那一行里:只画这几行，不另起「连接」一组(资源库详情里才有组头)。 */
  embedded?: boolean
  description?: ReactNode
  trigger?: ReactElement | null
  label?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean, details?: { reason?: string; event?: Event }) => void
  anchor?: { getBoundingClientRect(): DOMRect }
  agent: AgentPayload
  machine: string | null
  onError?: (notice: SwitchNotice | null) => void
}) {
  const { translate } = useSessionMessages()
  const [localOpen, setLocalOpen] = useState(false)
  const open = requestedOpen ?? localOpen
  const setOpen = useCallback(
    (value: boolean, details?: { reason?: string; event?: Event }) => {
      setLocalOpen(value)
      onOpenChange?.(value, details)
    },
    [onOpenChange]
  )
  const [adding, setAdding] = useState(false)
  const [modelAccountId, setModelAccountId] = useState<string>()
  const showSignIn = useShowModal('agentSignInModal')
  const host = useLibraryHost()
  // A failed read says so at once on every surface (a value already read stays, with the failure next to it).
  const { listed, connections, native, form, cliSignIn } = useListedConnections(machine, agent)
  const connectionsError = connections.state === 'unknown' ? null : connections.error
  const nativeError = native.state === 'unknown' ? null : native.error
  const empty = listed?.length === 0
  const changeOpen = (next: boolean, details?: { reason?: string; event?: Event }) => {
    if (next && empty) setAdding(true)
    else setOpen(next, details)
  }
  const method = resolveSignInMethod(agent.capabilities)
  // 账号连接(多个账号、各自登录)只有 Claude / Codex;其余家的账号就是它 CLI 自己那份登录(`cliSignIn`)。
  const canSignIn = !!form?.accounts && method?.kind === 'cli-login' && (!machine || !!method.headlessArgs)
  // 面板也从新建任务、会话里打开:CLI 自己那份登在连接所属的那台机器上,❌ 落到资源库正在看的那台。
  const remote = machine
    ? {
        deviceId: machine,
        deviceLabel:
          host.remote?.deviceId === machine
            ? host.remote.deviceLabel
            : (remoteHostsStore.device(machine)?.label ?? machine)
      }
    : null
  const cli = useAgentSignIn(agent, { probe: settingsRows && cliSignIn, remote })
  /**
   * CLI 自己的账号:现有 CLI 配置还没登上(或几个程序还差一步)就给,❌ 对登好的再登一遍。
   * 正在用的是不是 API Key 不相干(owner 2026-11-12「要一直都在」):那一趟登录恒在原生环境里跑
   * (主进程 `harnessLoginConnectionId`),登的是 CLI 自己那份,选中的 key 不进去。
   */
  const cliAccount =
    cliSignIn &&
    !!cli.row?.canSignIn &&
    ((native.state === 'value' ? native.value.status.kind : undefined) !== 'authenticated' || cli.row.status === 'partial')
  const accountMethod: AccountMethod = canSignIn ? 'connection' : cliAccount ? 'cli' : null
  const vendorKeyMethod = form?.vendorKey === true
  const canAdd = accountMethod !== null || vendorKeyMethod
  const refresh = () => {
    refreshTag(SUBSCRIPTIONS, machine, agent.id)
    void harnessModelCredential.refresh(agent.id)
  }
  const action = useMutation({
    mutationFn: async ({
      kind,
      id,
      stopBusySessions
    }: {
      kind: 'select' | 'remove' | 'refresh'
      id: string
      stopBusySessions?: true
    }) => {
      const client = await getAgentConfigRuntimeClient(machine)
      if (kind === 'refresh') {
        const reading = await client.refreshAuthStatus({ providerId: agent.id, connectionId: id })
        if (!reading.success) throw new Error(errorText(reading.error))
      } else {
        const input: { providerId: string; connectionId: string } = {
          providerId: agent.id,
          connectionId: id
        }
        // 删当前连接也是一次切换(落回原生):被「有会话在忙」拒过后同样能「关掉并切换」。
        const command = stopBusySessions ? { ...input, stopBusySessions } : input
        const result =
          kind === 'select'
            ? await client.selectConnection(command)
            : await client.removeConnection(command)
        if (!result.success) throw new ConnectionActionError(result.error)
      }
      // Commit the connection first. Model refresh failure must not disguise a successful switch.
      refresh()
      setOpen(false)
      if (kind === 'select' || (connections.state === 'value' && connections.value.some((c) => c.current && c.id === id))) {
        await forceRefreshHarnessModelCatalog(agent.id, 'acp', machine)
      }
    }
  })
  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const result = await (await getAgentConfigRuntimeClient(machine)).renameConnection({ providerId: agent.id, connectionId: id, name });
      if (!result.success) throw new Error(errorText(result.error));
      await refreshTag(SUBSCRIPTIONS, machine, agent.id);
    },
  });
  // 没有连接可管的家只有它 CLI 自己那一份:列着的就是正在用的,选它没有可切的。
  const select = (id: string) => {
    if (form) action.mutate({ kind: 'select', id })
  }
  // 跟最近一次动作走:新动作一开始 `action.error` 就清空,重叠的两次里先失败的那次不会把原因留下。
  const busy = sessionsBusyOf(action.error)
  // 带着「关掉」还被拒 = 那台机器上的咕咕不认这一格(旧版本):说清楚去更新，❌ 再摆一个按了没反应的按钮。
  const closeUnsupported = !!busy && action.variables?.stopBusySessions === true
  // 点了「关掉并切换」到切完之间(等进程退出，最多几十秒):原地说正在做什么,❌ 那一行先空掉、像没反应。
  const closing = action.isPending && action.variables?.stopBusySessions === true
  const failure = closing
    ? translate('subscriptions.connections.closing', { provider: agent.name })
    : closeUnsupported
      ? translate('subscriptions.connections.closeUnsupported')
      : busy
        ? translate('subscriptions.connections.busy', { count: busy.count, provider: agent.name })
        : action.error
          ? errorText(action.error)
          : null
  const tone = closing || (busy && !closeUnsupported) ? 'gentle' : 'error'
  const [progress, setProgress] = useState<{ closed: number; total: number } | null>(null)
  useEffect(() => {
    if (!closing) return
    return onMachineEvent(machine, subscriptionSwitchProgressChannel, (event) => {
      if (event.providerId === agent.id) setProgress({ closed: event.closed, total: event.total })
    })
  }, [closing, machine, agent.id])
  // 被拒的那次是切到哪个连接、还是删掉当前那个:「关掉并切换」原样再做一次。
  const refused =
    busy && !closeUnsupported && action.variables && action.variables.kind !== 'refresh'
      ? action.variables
      : null
  const refusedId = refused?.id ?? null
  const refusedKind = refused?.kind ?? null
  const { mutate } = action
  const closeAndSwitch = useCallback(() => {
    if (!refusedId || !refusedKind) return
    setProgress(null)
    mutate({ kind: refusedKind, id: refusedId, stopBusySessions: true })
  }, [refusedId, refusedKind, mutate])
  useEffect(() => {
    onError?.(
      failure === null
        ? null
        : {
            tone,
            text: failure,
            ...(refusedId ? { closeAndSwitch } : {}),
            ...(closing ? { progress } : {})
          }
    )
  }, [failure, tone, refusedId, closeAndSwitch, closing, progress, onError])
  /**
   * 从新建任务、会话里打开(`open` 由外面给):一个连接都没有就直接是「添加连接」表单,❌ 先弹一个只有
   * 「添加连接」一项的菜单。刚存好一把 API Key 回来重开菜单的那一下除外(列表还没重读完)。
   */
  const reopenedAfterSave = useRef(false)
  const wasRequested = useRef(false)
  const addWhenRead = useRef(false)
  const listedRead = listed !== undefined
  useEffect(() => {
    const opened = !!requestedOpen && !wasRequested.current
    wasRequested.current = !!requestedOpen
    if (opened) {
      addWhenRead.current = !reopenedAfterSave.current
      reopenedAfterSave.current = false
    }
    if (!requestedOpen) addWhenRead.current = false
    if (!addWhenRead.current || !listedRead) return
    addWhenRead.current = false
    if (!empty || !canAdd) return
    setAdding(true)
    setOpen(false)
  }, [requestedOpen, listedRead, empty, canAdd, setOpen])
  /** 刚加的账号连接窗口关了还没登上:这条没有用处,拿掉(见 `dropIfNeverSignedIn`)。失败只记日志 —— 留下一条就是原来的样子。 */
  const dropIfUnsigned = async (connectionId: string) => {
    try {
      const client = await getAgentConfigRuntimeClient(machine)
      const outcome = await dropIfNeverSignedIn(client, { providerId: agent.id, connectionId })
      if (outcome === 'removed') setModelAccountId(current => current === connectionId ? undefined : current)
    } catch (error) {
      rendererLogger('settings/subscriptions').warn({ error, providerId: agent.id }, 'unsigned connection not removed')
    } finally {
      refresh()
    }
  }
  /**
   * 当前是「没有」(落在原生、原生又不列)时,新加的那一条直接成为当前连接(owner 2026-11-12:刚加的 key 却还没用上)。
   * 走的就是切换那条路:有会话在忙照样被拒、给「关掉并切换」,连接已经加上、只是没切。已有当前真连接时不动它。
   * 面板(下拉)没有行可以摆那句拒绝:把菜单打开,拒绝写在菜单里。
   */
  const nothingCurrent = listed !== undefined && !listed.some((c) => c.current)
  const adopt = (connectionId: string) =>
    action.mutate(
      { kind: 'select', id: connectionId },
      {
        onError: () => {
          if (!settingsRows && !onError) setOpen(true)
        }
      }
    )
  const signIn = (connectionId: string, fresh = false, adoptWhenSignedIn = false) => {
    if (!method || !canSignIn) return
    setOpen(false)
    const finished = () =>
      adoptWhenSignedIn ? adopt(connectionId) : action.mutate({ kind: 'refresh', id: connectionId })
    showSignIn({
      providerId: agent.id,
      providerName: agent.name,
      connectionId,
      steps: [{ methodId: method.id }],
      ...(machine
        ? {
            remote: {
              deviceId: machine,
              deviceLabel: host.remote?.deviceLabel ?? '',
              headless: true,
              command: agent.id
            }
          }
        : {}),
      onSuccess: finished,
      onClose: fresh ? () => void dropIfUnsigned(connectionId) : () => action.mutate({ kind: 'refresh', id: connectionId })
    })
  }
  /** 「添加连接 → 账号」在只能登 CLI 自己那一份的家:就是从前那颗「登录」做的事,同一个登录窗口。 */
  const signInCli = () => {
    setAdding(false)
    setOpen(false)
    cli.openSignIn()
  }
  const signInAttempt = useRef<object | null>(null)
  useEffect(() => {
    if (!signInRequested || signInAttempt.current === signInRequested) return
    if (connectionsError || nativeError) {
      signInAttempt.current = signInRequested
      setOpen(true)
      return
    }
    if (!listedRead) return
    signInAttempt.current = signInRequested
    if (canSignIn) signIn(listed?.find(connection => connection.current)?.id ?? 'native')
    else if (cliSignIn) signInCli()
    else setOpen(true)
  }, [signInRequested, listedRead, listed, connectionsError, nativeError, canSignIn, cliSignIn, signIn, signInCli, setOpen])
  const onCreated = (connection: HarnessConnection) => {
    refresh()
    setAdding(false)
    // 账号连接要登上才能用:登上那一刻再切;API Key 存好就能用,当场切。
    if (vendorKeyMethod) { if (nothingCurrent) adopt(connection.id) }
    else if (connection.kind === 'account') signIn(connection.id, true, nothingCurrent)
    // 已有当前连接:就地表单(订阅页那一行、资源库详情)收起就完,新的一条躺在列表里,❌ 自己把选择框弹开。
    // 面板(新建任务、会话里打开)的表单是从菜单里点出来的弹窗:存好回到那份菜单,新的一条在里面可选。
    else if (!settingsRows) {
      reopenedAfterSave.current = true
      setOpen(true)
    }
  }
  const connectionForm = (
    <ConnectionForm
      agent={agent}
      machine={machine}
      account={accountMethod}
      vendorKey={vendorKeyMethod}
      onCreated={onCreated}
      onCliSignIn={signInCli}
      {...(settingsRows ? { onCancel: () => setAdding(false) } : {})}
    />
  )
  // Account sign-in stays reachable even when a revoked token's file still reads as authenticated.
  const current = listed?.find((c) => c.current)
  const currentDetails = useConnectionDetails(machine, agent.id, current?.id)
  const currentStatus = currentDetails.state === 'value' ? currentDetails.value.status : undefined
  const currentSignIn = canSignIn && current && !(currentStatus?.kind === 'authenticated' && currentStatus.credentialKind === 'api-key') && (
    <Button
      size={settingsRows ? 'sm' : 'xs'}
      variant="outline"
      disabled={action.isPending}
      data-testid={`subscription-sign-in-${agent.id}`}
      onClick={() => signIn(current.id)}
    >
      {translate(
        currentStatus?.kind === 'unauthenticated' && currentStatus.reason !== 'expired'
          ? 'subscriptions.connections.signIn'
          : 'subscriptions.connections.signInAgain'
      )}
    </Button>
  )
  const options = (selectItem: boolean) =>
    listed?.map((connection) => (
      <ConnectionOption
        key={connection.id}
        connection={connection}
        agent={agent}
        machine={machine}
        busy={action.isPending}
        selectItem={selectItem}
        onSignIn={canSignIn ? () => signIn(connection.id) : undefined}
        onRemove={() => action.mutate({ kind: 'remove', id: connection.id })}
      />
    ))
  return (
    <>
      {modelRows ? <SubscriptionModelRows notice={failure ? <SwitchNoticeLine notice={{ tone, text: failure, ...(refusedId ? { closeAndSwitch } : {}), ...(closing ? { progress } : {}) }} /> : undefined} agent={agent} machine={machine} connections={listed} busy={action.isPending || rename.isPending}
        onSignIn={id => signIn(id)} onRemove={id => action.mutate({ kind: 'remove', id })} onSelect={select} onRename={(id, name) => rename.mutateAsync({ id, name })}
        onRetry={refresh} error={rename.error ? translate('mcpLibrary.saveFailed') : connectionsError || nativeError ? translate('customModels.connectionsReadFailed', { provider: agent.name }) : null} /> : modelAccount ? <ConnectionForm
          agent={agent} machine={machine} account={accountMethod} vendorKey={false}
          onCreated={connection => { setModelAccountId(connection.id); onCreated(connection) }} onCliSignIn={signInCli}
          modelAccount={{ connectionId: modelAccountId, onLogin: () => { if (modelAccountId) signIn(modelAccountId) }, onClose: modelAccount.onClose, onBusyChange: modelAccount.onBusyChange }}
        /> : settingsRows ? (
        <ConnectionSettingsRows
          signIn={currentSignIn || undefined}
          connections={listed}
          unreadable={!!connectionsError && listed === undefined}
          open={open}
          onOpenChange={setOpen}
          onSelect={select}
          onAdd={canAdd ? () => setAdding(true) : undefined}
          addHint={translate(vendorKeyMethod ? 'agentsPage.connectionAddHintApiKey' : 'agentsPage.connectionAddHintAccount')}
          busy={action.isPending}
          description={description}
          agentId={agent.id}
          embedded={embedded}
          notice={
            failure ? (
              <SwitchNoticeLine
                notice={{
                  tone,
                  text: failure,
                  ...(refusedId ? { closeAndSwitch } : {}),
                  ...(closing ? { progress } : {})
                }}
              />
            ) : (
              connectionsError && (
                <p className="subscription-error" role="alert">
                  {errorText(connectionsError)}
                </p>
              )
            )
          }
          form={adding && canAdd ? connectionForm : null}
          localConfiguration={<AgentHomeRow providerId={agent.id} machine={machine ?? null} />}
        >
          {open && options(true)}
        </ConnectionSettingsRows>
      ) : (
        <DropdownMenu open={open} onOpenChange={changeOpen}>
          {/* 由别处的按钮打开(`trigger === null`:新建任务、会话、助理设置引导)也挂一个不显示的 Trigger。
              Base UI 1.6 的根菜单只从挂着的 Trigger 拿到自己在浮层树里的节点号;没有它,连接那一行的 ⋯ 子菜单一打开,
              根菜单就把它当「兄弟菜单」(`sibling-open`)整个关掉 —— ⋯ 里的登录、管理模型、移除都点不到。
              位置照旧跟 `anchor`,关掉后焦点照旧回到打开它的那个按钮。 */}
          {trigger === null && <DropdownMenuTrigger nativeButton={false} render={<span hidden />} />}
          {/* 「重新登录」与「切换连接」并排一行;操作列本身是竖排的,❌ 让它俩上下叠。 */}
          <div className="flex items-center gap-1">
            {trigger === undefined && currentSignIn}
            {trigger !== null && (canAdd || !empty) && (
              <DropdownMenuTrigger
                render={
                  trigger ?? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={action.isPending}
                      data-testid={`subscription-switch-${agent.id}`}
                    />
                  )
                }
              >
                {label ??
                  (empty ? (
                    translate('subscriptions.connections.add')
                  ) : (
                    <>
                      {translate('subscriptions.connections.switch')}
                      <ChevronDown className="ml-1 size-3" />
                    </>
                  ))}
              </DropdownMenuTrigger>
            )}
          </div>
          <DropdownMenuContent align="end" anchor={anchor} className="subscription-connection-menu">
            {/* 与订阅页那一行同一句、同一个出路(被拒时「关掉并切换」)。 */}
            {!onError && failure && (
              <div className="p-2">
                <SwitchNoticeLine
                  notice={{
                    tone,
                    text: failure,
                    ...(refusedId ? { closeAndSwitch } : {}),
                    ...(closing ? { progress } : {})
                  }}
                />
              </div>
            )}
            {listed === undefined && !connectionsError && <Unknown className="m-2 h-3 w-40" />}
            {connectionsError && (
              <p className="subscription-error p-2" role="alert">
                {errorText(connectionsError)}
              </p>
            )}
            <DropdownMenuRadioGroup value={current?.id ?? ''} onValueChange={select}>
              {open && options(false)}
            </DropdownMenuRadioGroup>
            {canAdd && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid="subscription-add-connection"
                  onClick={() => {
                    setOpen(false)
                    setAdding(true)
                  }}
                >
                  <Plus className="size-4" />
                  {translate('subscriptions.connections.add')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog open={adding && canAdd && !settingsRows} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {translate('subscriptions.connections.addTitle', { provider: agent.name })}
            </DialogTitle>
          </DialogHeader>
          <DialogContentArea>{connectionForm}</DialogContentArea>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ConnectionOption({
  connection,
  agent,
  machine,
  busy,
  onRemove,
  onSignIn,
  selectItem = false
}: {
  connection: HarnessConnection
  agent: AgentPayload
  machine: string | null
  busy: boolean
  selectItem?: boolean
  onRemove: () => void
  onSignIn?: () => void
}) {
  const { translate } = useSessionMessages()
  const reading = useConnectionDetails(machine, agent.id, connection.id)
  const details = reading.state === 'value' ? reading.value : undefined
  const detailsError = reading.state === 'unknown' ? null : reading.error
  // 不切过去也看得到这个号还剩多少(10-30 owner):按连接读，与「订阅」行同一把键、同一份读数。
  // 没登录的号没有额度可读;API key 的余量只在厂商后台。
  const usage = useSubscriptionUsage(machine, agent.id, connection.id, details?.status.kind === 'authenticated')
  const windows = usage.state === 'value' && usage.value.kind === 'windows' ? usage.value.windows : null
  const quota = windows ? remainingLine(windows, translate) : null
  const nearlyUsed = !!windows && windows.some((window) => window.usedPercent >= NEARLY_USED_PERCENT)
  const status = details?.status
  const canSignIn = !!onSignIn && !(status?.kind === 'authenticated' && status.credentialKind === 'api-key')
  const signInLabel = translate(status?.kind === 'unauthenticated' && status.reason !== 'expired'
    ? 'subscriptions.connections.signIn' : 'subscriptions.connections.signInAgain')
  const name =
    connection.kind === 'native' ? translate('subscriptions.connections.existing') : connection.name
  const plan = details?.plan
  const description =
    status?.kind === 'authenticated' && status.account
      ? status.account
      : // 「现有 CLI 配置」写它登的是谁、谁在付钱(Pi 这类没有账号读数的家靠这一条)。
        connection.kind === 'native' && plan && nativeConfigured(details)
        ? payerLine(plan, translate, false)
        : status?.kind === 'unauthenticated'
          ? translate(
              status.reason === 'expired'
                ? 'subscriptions.connections.expired'
                : 'subscriptions.connections.signedOut'
            )
          : reading.state === 'unknown'
            ? <Unknown className="w-28" />
            : translate('subscriptions.connections.account')
  const Choice = selectItem ? SelectItem : DropdownMenuRadioItem
  const options = (
    <>
      {canSignIn && (
        <DropdownMenuItem disabled={busy} onClick={onSignIn}>
          {signInLabel}
        </DropdownMenuItem>
      )}
      {connection.kind !== 'native' && <DropdownMenuItem disabled={busy} variant="destructive" onClick={onRemove}>
        {translate('subscriptions.connections.remove')}
      </DropdownMenuItem>}
    </>
  )
  return (
    <div className="subscription-connection-option" data-testid={`connection-${connection.id}`}>
      {/* A refused menu switch stays open; a committed switch closes it itself. */}
      <Choice
        {...(!selectItem ? { closeOnClick: false } : {})}
        value={connection.id}
        data-testid={`connection-use-${connection.id}`}
        disabled={
          busy ||
          reading.state === 'unknown' ||
          (connection.kind === 'account' && status?.kind !== 'authenticated')
        }
        className="subscription-connection-choice"
      >
        <span>
          <span className="subscription-connection-name">
            {name}
            {details?.plan?.plan && (
              <span className="subscription-plan-badge">{details.plan.plan}</span>
            )}
          </span>
          <span className="subscription-connection-description block">{description}</span>
          {quota && (
            <span
              className="subscription-connection-quota block"
              data-testid={`connection-quota-${connection.id}`}
              data-warning={nearlyUsed || undefined}
            >
              {quota}
            </span>
          )}
          {detailsError && (
            <span className="subscription-error block">{errorText(detailsError)}</span>
          )}
        </span>
      </Choice>
      {/* 当前连接也能删(落回原生);「现有 CLI 配置」是 CLI 自己那一份，删不掉。 */}
      {(connection.kind !== 'native' || canSignIn) &&
        (selectItem ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={translate('subscriptions.connections.options', { name })}
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{options}</DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              aria-label={translate('subscriptions.connections.options', { name })}
              className="subscription-connection-options"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {options}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
    </div>
  )
}

/** 「5 小时剩余 29% · 每周剩余 50%」—— 与「订阅」行的额度条同一种算法，只是压成一行。 */
function remainingLine(
  windows: readonly SubscriptionUsageWindow[],
  translate: ReturnType<typeof useSessionMessages>['translate']
): string {
  const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
  return windows
    .map(
      (window) =>
        `${translate('subscriptions.remaining', { window: windowLabel(window, translate) })} ${percent.format(100 - Math.min(100, Math.max(0, window.usedPercent)))}%`
    )
    .join(metadataSeparator())
}

function ConnectionForm({ agent, machine, account, vendorKey, onCreated, onCliSignIn, onCancel, modelAccount }: {
  agent: AgentPayload
  machine: string | null
  account: AccountMethod
  vendorKey: boolean
  onCreated: (connection: HarnessConnection) => void
  onCliSignIn: () => void
  onCancel?: () => void
  modelAccount?: { connectionId?: string; onLogin: () => void; onClose: () => void; onBusyChange?: (busy: boolean) => void }
}) {
  const { translate } = useSessionMessages()
  const cliAccount = account === 'cli' && !vendorKey
  const create = useMutation({
    mutationFn: async (element?: HTMLFormElement) => {
      const data = element ? new FormData(element) : new FormData()
      const result = await (await getAgentConfigRuntimeClient(machine)).createConnection({
        providerId: agent.id, kind: 'account',
        name: String(data.get('name') ?? '').trim() || undefined,
        ...(vendorKey ? { apiKey: String(data.get('apiKey') ?? '').trim() } : {}),
      })
      if (!result.success) throw new Error(errorText(result.error))
      element?.reset()
      return result.data
    },
    onSuccess: onCreated,
  })
  const onBusyChange = modelAccount?.onBusyChange
  useEffect(() => { onBusyChange?.(create.isPending); return () => onBusyChange?.(false) }, [create.isPending, onBusyChange])
  if (modelAccount) return <SubscriptionAccountField agent={agent} machine={machine} connectionId={modelAccount.connectionId}
    creating={create.isPending} failure={create.error ? errorText(create.error) : null}
    onLogin={() => { if (modelAccount.connectionId) modelAccount.onLogin(); else create.mutate(undefined) }}
    onSave={modelAccount.onClose} onCancel={modelAccount.onClose} />
  return <form className="subscription-connection-form" onSubmit={(event) => {
    event.preventDefault()
    if (cliAccount) onCliSignIn()
    else create.mutate(event.currentTarget)
  }} onKeyDown={(event) => { if (event.key === 'Escape') onCancel?.() }}>
    {vendorKey ? <label>API Key<Input name="apiKey" type="password" required autoComplete="off" spellCheck={false} /></label>
      : <p className="subscription-connection-description">{cliAccount
        ? translate('subscriptions.connections.cliAccountHint', { provider: agent.name })
        : translate('subscriptions.connections.accountHint')}</p>}
    {!cliAccount && <>
      <label>{translate('subscriptions.connections.remark')}<Input name="name" maxLength={80} placeholder={translate('subscriptions.connections.remarkPlaceholder')} /></label>
      <p className="subscription-connection-description">{translate('subscriptions.connections.private')}</p>
    </>}
    {create.error && <p className="subscription-error" role="alert">{errorText(create.error)}</p>}
    <div className="subscription-connection-form-actions">
      <Button type="submit" size="sm" disabled={create.isPending}>{create.isPending
        ? translate('subscriptions.connections.saving') : vendorKey
          ? translate('subscriptions.connections.save') : cliAccount
            ? translate('subscriptions.connections.signIn') : translate('subscriptions.connections.addAndSignIn')}</Button>
      {vendorKey && account === 'cli' && <Button type="button" size="sm" variant="outline" disabled={create.isPending} onClick={onCliSignIn}>{translate('subscriptions.connections.signIn')}</Button>}
      {onCancel && <Button type="button" size="sm" variant="outline" disabled={create.isPending} onClick={onCancel}>{translate('agentsPage.cancel')}</Button>}
    </div>
  </form>
}
