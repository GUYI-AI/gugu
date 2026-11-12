import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ChevronDown, MoreHorizontal, Plus } from '@/lib/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import { type AgentConnectionForm, type AgentPayload } from '@shared/core/agents/agent-payload'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { onMachineEvent } from '@renderer/lib/ipc'
import { subscriptionSwitchProgressChannel } from '@shared/core/sessions/subscriptionSwitchEvents'
import { useShowModal } from '@renderer/lib/modal/modal-provider'
import { Button } from '@renderer/lib/ui/button'
import { SelectItem } from '@renderer/lib/ui/select'
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
import { harnessModelCredentialKey } from '@renderer/lib/stores/use-harness-model-credential'
import { resolveSignInMethod } from '../agents-page/agent-account'
import { useAgentSignIn } from '../agents-page/use-agent-sign-in'
import { dropIfNeverSignedIn } from './drop-unsigned-connection'
import { rendererLogger } from '@/lib/log'
import type { SubscriptionUsageWindow } from '@gugu/session-core/agents/plugins'
import {
  ConnectionActionError,
  errorText,
  readUsage,
  sessionsBusyOf,
  SUBSCRIPTION_STALE_MS,
  subscriptionKey
} from './subscription-queries'
import { NEARLY_USED_PERCENT, payerLine, windowLabel } from './subscription-view'
import { nativeConfigured, useConnectionDetails, useListedConnections } from './listed-connections'
import { SwitchNoticeLine } from './SwitchNoticeLine'
import { ConnectionModelPicker, modelsLine } from './ConnectionModelPicker'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
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
 * 下拉里摆一个空的「现有 CLI 配置」(owner 2026-11-12)。表单里的方式照这家支持的给:账号 | API Key。
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
  description
}: {
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
  const queryClient = useQueryClient()
  const showSignIn = useShowModal('agentSignInModal')
  const host = useLibraryHost()
  // 资源库详情里后台重读失败就退避重试(读数留着);订阅页那一行读失败当场说出来。
  const { listed, connections, native, form, cliSignIn } = useListedConnections(machine, agent, settingsRows && !embedded)
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
    (native.data?.status.kind !== 'authenticated' || cli.row.status === 'partial')
  const accountMethod: AccountMethod = canSignIn ? 'connection' : cliAccount ? 'cli' : null
  const apiKeyMethod = form !== null
  const canAdd = accountMethod !== null || apiKeyMethod
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: subscriptionKey(machine, agent.id) })
    void queryClient.invalidateQueries({ queryKey: harnessModelCredentialKey(agent.id) })
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
      if (kind === 'select' || connections.data?.some((c) => c.current && c.id === id)) {
        await forceRefreshHarnessModelCatalog(queryClient, agent.id, 'acp', machine)
      }
    }
  })
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
      await dropIfNeverSignedIn(client, { providerId: agent.id, connectionId })
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
  const onCreated = (connection: HarnessConnection) => {
    refresh()
    setAdding(false)
    // 账号连接要登上才能用:登上那一刻再切;API Key 存好就能用,当场切。
    if (connection.kind === 'account') signIn(connection.id, true, nothingCurrent)
    else if (nothingCurrent) adopt(connection.id)
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
      apiKey={apiKeyMethod}
      form={form}
      onCreated={onCreated}
      onCliSignIn={signInCli}
      {...(settingsRows ? { onCancel: () => setAdding(false) } : {})}
    />
  )
  // 正在用的连接登不上了(失效 / 没登录):「登录」直接摆在外面,❌ 藏进「切换连接 → ⋯」两层菜单里。
  const current = listed?.find((c) => c.current)
  const currentStatus = useConnectionDetails(
    machine,
    agent.id,
    current?.kind === 'account' ? current.id : undefined
  ).data?.status
  const currentSignIn = canSignIn && current && currentStatus?.kind === 'unauthenticated' && (
    <Button
      size={settingsRows ? 'sm' : 'xs'}
      variant="outline"
      disabled={action.isPending}
      data-testid={`subscription-sign-in-${agent.id}`}
      onClick={() => signIn(current.id)}
    >
      {translate(
        currentStatus.reason === 'expired'
          ? 'subscriptions.connections.signInAgain'
          : 'subscriptions.connections.signIn'
      )}
    </Button>
  )
  // 「管理模型」的弹窗挂在菜单外面:菜单一关,里面的行就卸了。
  const [managing, setManaging] = useState<HarnessConnection | null>(null)
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
        {...(connection.kind === 'api-key' && form?.model === 'required'
          ? {
              onManageModels: () => {
                setOpen(false)
                setManaging(connection)
              }
            }
          : {})}
      />
    ))
  return (
    <>
      {settingsRows ? (
        <ConnectionSettingsRows
          signIn={currentSignIn || undefined}
          connections={listed}
          unreadable={!!connections.error && listed === undefined}
          open={open}
          onOpenChange={setOpen}
          onSelect={select}
          onAdd={canAdd ? () => setAdding(true) : undefined}
          addHint={translate(
            accountMethod && apiKeyMethod
              ? 'agentsPage.connectionAddHint'
              : apiKeyMethod
                ? 'agentsPage.connectionAddHintApiKey'
                : 'agentsPage.connectionAddHintAccount'
          )}
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
              connections.error && (
                <p className="subscription-error" role="alert">
                  {errorText(connections.error)}
                </p>
              )
            )
          }
          form={adding && canAdd ? connectionForm : null}
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
            {listed === undefined && !connections.error && (
              <p className="p-2 text-xs">{translate('subscriptions.checking')}</p>
            )}
            {connections.error && (
              <p className="subscription-error p-2" role="alert">
                {errorText(connections.error)}
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
      <ManageModelsDialog
        agent={agent}
        machine={machine}
        connection={managing}
        onClose={() => setManaging(null)}
        onSaved={async (connection) => {
          refresh()
          setManaging(null)
          // 正在用的就是它:新建任务的模型菜单照新的几个重读。
          if (connection.current) await forceRefreshHarnessModelCatalog(queryClient, agent.id, 'acp', machine)
        }}
      />
    </>
  )
}

/**
 * 「管理模型」(#2507):换一把已存连接点名的模型,与新建时同一个选择器;清单由宿主拿这把连接自己的 key 读。
 * 订阅页那一行与面板(新建任务、会话)都从连接的 ⋯ 打开它。
 */
function ManageModelsDialog({
  agent,
  machine,
  connection,
  onClose,
  onSaved
}: {
  agent: AgentPayload
  machine: string | null
  connection: HarnessConnection | null
  onClose: () => void
  onSaved: (connection: HarnessConnection) => Promise<void>
}) {
  const { translate } = useSessionMessages()
  return (
    <Dialog open={connection !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {translate('subscriptions.connections.manageModelsTitle', { name: connection?.name ?? '' })}
          </DialogTitle>
        </DialogHeader>
        <DialogContentArea>
          {connection && (
            <ManageModelsForm
              key={connection.id}
              agent={agent}
              machine={machine}
              connection={connection}
              onCancel={onClose}
              onSaved={onSaved}
            />
          )}
        </DialogContentArea>
      </DialogContent>
    </Dialog>
  )
}

function ManageModelsForm({
  agent,
  machine,
  connection,
  onCancel,
  onSaved
}: {
  agent: AgentPayload
  machine: string | null
  connection: HarnessConnection
  onCancel: () => void
  onSaved: (connection: HarnessConnection) => Promise<void>
}) {
  const { translate } = useSessionMessages()
  const [models, setModels] = useState<string[]>(connection.models ?? [])
  const [missing, setMissing] = useState(false)
  const save = useMutation({
    mutationFn: async () => {
      const result = await (
        await getAgentConfigRuntimeClient(machine)
      ).updateConnectionModels({ providerId: agent.id, connectionId: connection.id, models })
      if (!result.success) throw new Error(errorText(result.error))
      return result.data
    },
    onSuccess: onSaved
  })
  return (
    <form
      className="subscription-connection-form"
      data-testid="connection-models-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (models.length === 0) setMissing(true)
        else save.mutate()
      }}
    >
      <ConnectionModelPicker
        machine={machine}
        providerId={agent.id}
        source={{ connectionId: connection.id }}
        value={models}
        onChange={(next) => {
          setModels(next)
          if (next.length > 0) setMissing(false)
        }}
      />
      {missing && (
        <p className="subscription-error" role="alert">
          {translate('subscriptions.connections.modelsRequired')}
        </p>
      )}
      {save.error && (
        <p className="subscription-error" role="alert">
          {errorText(save.error)}
        </p>
      )}
      <div className="subscription-connection-form-actions">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? translate('subscriptions.connections.saving') : translate('subscriptions.connections.saveModels')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={save.isPending} onClick={onCancel}>
          {translate('agentsPage.cancel')}
        </Button>
      </div>
    </form>
  )
}


function ConnectionOption({
  connection,
  agent,
  machine,
  busy,
  onRemove,
  onSignIn,
  onManageModels,
  selectItem = false
}: {
  connection: HarnessConnection
  agent: AgentPayload
  machine: string | null
  busy: boolean
  selectItem?: boolean
  onRemove: () => void
  onSignIn?: () => void
  /** 点名模型的家的 API Key 连接才有:换它的模型,❌ 删了重加。 */
  onManageModels?: () => void
}) {
  const { translate } = useSessionMessages()
  const details = useConnectionDetails(machine, agent.id, connection.id)
  // 不切过去也看得到这个号还剩多少(10-30 owner):按连接读，与「订阅」行同一把键、同一份读数。
  const usage = useQuery({
    queryKey: subscriptionKey(machine, agent.id, 'usage', connection.id),
    queryFn: () => readUsage(machine, agent.id, false, connection.id),
    staleTime: SUBSCRIPTION_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
    // 没登录的号没有额度可读;API key 的余量只在厂商后台。
    enabled: connection.kind !== 'api-key' && details.data?.status.kind === 'authenticated'
  })
  const quota = usage.data?.kind === 'windows' ? remainingLine(usage.data.windows, translate) : null
  const nearlyUsed =
    usage.data?.kind === 'windows' &&
    usage.data.windows.some((window) => window.usedPercent >= NEARLY_USED_PERCENT)
  const status = details.data?.status
  const canSignIn =
    !!onSignIn && connection.kind === 'account' && status?.kind === 'unauthenticated'
  const name =
    connection.kind === 'native' ? translate('subscriptions.connections.existing') : connection.name
  const plan = details.data?.plan
  const description =
    status?.kind === 'authenticated' && status.account
      ? status.account
      : // 「现有 CLI 配置」写它登的是谁、谁在付钱(Pi 这类没有账号读数的家靠这一条)。
        connection.kind === 'native' && plan && nativeConfigured(details.data)
        ? payerLine(plan, translate, false)
        : connection.kind === 'api-key'
        ? [
            connection.endpoint
              ? new URL(connection.endpoint).host
              : translate('subscriptions.connections.officialApi'),
            modelsLine(connection.models, translate)
          ]
            .filter(Boolean)
            .join(' · ')
        : status?.kind === 'unauthenticated'
          ? translate(
              status.reason === 'expired'
                ? 'subscriptions.connections.expired'
                : 'subscriptions.connections.signedOut'
            )
          : details.isPending
            ? translate('subscriptions.checking')
            : translate('subscriptions.connections.account')
  const Choice = selectItem ? SelectItem : DropdownMenuRadioItem
  const options = (
    <>
      {canSignIn && (
        <DropdownMenuItem disabled={busy} onClick={onSignIn}>
          {translate('subscriptions.connections.signIn')}
        </DropdownMenuItem>
      )}
      {onManageModels && (
        <DropdownMenuItem disabled={busy} onClick={onManageModels}>
          {translate('subscriptions.connections.manageModels')}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem disabled={busy} variant="destructive" onClick={onRemove}>
        {translate('subscriptions.connections.remove')}
      </DropdownMenuItem>
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
          details.isPending ||
          (connection.kind === 'account' && status?.kind !== 'authenticated')
        }
        className="subscription-connection-choice"
      >
        <span>
          <span className="subscription-connection-name">
            {name}
            {details.data?.plan?.plan && (
              <span className="subscription-plan-badge">{details.data.plan.plan}</span>
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
          {details.error && (
            <span className="subscription-error block">{errorText(details.error)}</span>
          )}
        </span>
      </Choice>
      {/* 当前连接也能删(落回原生);「现有 CLI 配置」是 CLI 自己那一份，删不掉。 */}
      {connection.kind !== 'native' &&
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
              {canSignIn && (
                <DropdownMenuItem disabled={busy} onClick={onSignIn}>
                  {translate('subscriptions.connections.signIn')}
                </DropdownMenuItem>
              )}
              {onManageModels && (
                <DropdownMenuItem disabled={busy} onClick={onManageModels}>
                  {translate('subscriptions.connections.manageModels')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem disabled={busy} variant="destructive" onClick={onRemove}>
                {translate('subscriptions.connections.remove')}
              </DropdownMenuItem>
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
    .join(' · ')
}

function ConnectionForm({
  agent,
  machine,
  account,
  apiKey,
  form,
  onCreated,
  onCliSignIn,
  onCancel
}: {
  agent: AgentPayload
  machine: string | null
  account: AccountMethod
  apiKey: boolean
  form: AgentConnectionForm | null
  onCreated: (connection: HarnessConnection) => void
  onCliSignIn: () => void
  /** 就地展开时(订阅页那一行、资源库详情)才有:「取消」与主按钮同一行。弹窗用它自己的关闭。 */
  onCancel?: () => void
}) {
  const { translate } = useSessionMessages()
  const [kind, setKind] = useState<'account' | 'api-key'>(account || !apiKey ? 'account' : 'api-key')
  // 登它 CLI 自己那一份:不存连接、不起名，直接是那个登录窗口。
  const cliAccount = kind === 'account' && account === 'cli'
  // 地址 + Key 是主体(owner 2026-11-12):有地址格的家一律摆出来,一开始就填好这家的官方地址(真值,❌ 占位);
  // 用中转就改掉它。官方那一个没改 ⇒ 宿主不记地址,处处读作「官方」。
  const endpointField = form?.endpoint ?? 'none'
  const showEndpoint = endpointField !== 'none'
  const showModel = form?.model === 'required'
  const official = form?.officialEndpoint ?? ''
  const [apiKeyText, setApiKeyText] = useState('')
  const [endpointText, setEndpointText] = useState(official)
  const [models, setModels] = useState<string[]>([])
  const [modelsMissing, setModelsMissing] = useState(false)
  const endpointValue = endpointText.trim()
  // 模型清单照这把 key 和这个地址读(宿主里读);地址还不成形就先不读。
  const modelSource =
    showModel && apiKeyText.trim() && (!showEndpoint || isEndpointUrl(endpointValue))
      ? { apiKey: apiKeyText.trim(), ...(showEndpoint && endpointValue ? { endpoint: endpointValue } : {}) }
      : null
  const create = useMutation({
    mutationFn: async (element: HTMLFormElement) => {
      const data = new FormData(element)
      const endpoint = String(data.get('endpoint') ?? '').trim()
      const result = await (
        await getAgentConfigRuntimeClient(machine)
      ).createConnection({
        providerId: agent.id,
        kind,
        name: String(data.get('name') ?? '').trim() || undefined,
        ...(kind === 'api-key'
          ? {
              apiKey: String(data.get('apiKey') ?? '').trim(),
              // 原样交给宿主:是不是官方由宿主判(同一个值),❌ 在这里先替它删。
              ...(showEndpoint && endpoint ? { endpoint } : {}),
              ...(showModel ? { models } : {})
            }
          : {})
      })
      if (!result.success) throw new Error(errorText(result.error))
      element.reset()
      setApiKeyText('')
      setEndpointText(official)
      setModels([])
      return result.data
    },
    onSuccess: onCreated
  })
  return (
    <form
      className="subscription-connection-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (cliAccount) onCliSignIn()
        else if (kind === 'api-key' && showModel && models.length === 0) setModelsMissing(true)
        else create.mutate(event.currentTarget)
      }}
      // 与「来源 → 自定义路径」那格一样:Esc 收起。
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onCancel) onCancel()
      }}
    >
      {/* 两种方式才有得选:照仓里的分段控件(SegmentedTabs pill,选中 = --muted 实底块)。
          ❌ 从前那对 secondary / ghost 按钮:选中底色 --background-2 就是卡片底色(--card)、字色两档一样,看不出选中。
          只有一种方式(Pi、Qwen 只接 Key;Kiro 只能登 CLI)就不画,直接是那一种表单。 */}
      {account && apiKey && (
        <SegmentedTabs<'account' | 'api-key'>
          items={[
            { value: 'account', label: translate('subscriptions.connections.account') },
            { value: 'api-key', label: 'API Key' }
          ]}
          value={kind}
          onChange={setKind}
          ariaLabel={translate('subscriptions.connections.method')}
        />
      )}
      {kind === 'api-key' ? (
        <>
          <label>
            API Key
            <Input
              name="apiKey"
              type="password"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
              // 换「账号 | API Key」再换回来:填过的还在(模型清单照它读)。
              defaultValue={apiKeyText}
              onChange={(event) => setApiKeyText(event.target.value)}
            />
          </label>
          {showEndpoint && (
            <label>
              {translate('subscriptions.connections.endpoint')}
              <Input
                name="endpoint"
                type="url"
                // 可选的家(Claude / Codex)清空 = 官方;离了地址起不来的家必填。
                required={endpointField === 'required'}
                defaultValue={endpointText}
                placeholder={official ? undefined : endpointPlaceholder(agent.id, form?.protocol)}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setEndpointText(event.target.value)}
              />
            </label>
          )}
          {/* 宿主按地址探接口的家(pi / opencode)❌ 再说「地址须支持某某接口」:它讲哪种就用哪种。 */}
          {showEndpoint && form?.protocol && !form.protocolDetected && (
            <p className="subscription-connection-description">
              {translate('subscriptions.connections.protocolHint', {
                protocol: PROTOCOL_NAMES[form.protocol]
              })}
            </p>
          )}
          {showModel && (
            <ConnectionModelPicker
              machine={machine}
              providerId={agent.id}
              source={modelSource}
              value={models}
              onChange={(next) => {
                setModels(next)
                if (next.length > 0) setModelsMissing(false)
              }}
            />
          )}
          {showModel && modelsMissing && (
            <p className="subscription-error" role="alert">
              {translate('subscriptions.connections.modelsRequired')}
            </p>
          )}
        </>
      ) : (
        <p className="subscription-connection-description">
          {cliAccount
            ? translate('subscriptions.connections.cliAccountHint', { provider: agent.name })
            : translate('subscriptions.connections.accountHint')}
        </p>
      )}
      {!cliAccount && (
        <>
          <label>
            {translate('subscriptions.connections.remark')}
            <Input
              name="name"
              maxLength={80}
              placeholder={translate('subscriptions.connections.remarkPlaceholder')}
            />
          </label>
          <p className="subscription-connection-description">
            {translate('subscriptions.connections.private')}
          </p>
        </>
      )}
      {create.error && (
        <p className="subscription-error" role="alert">
          {errorText(create.error)}
        </p>
      )}
      {/* 照「来源 → 自定义路径」那格:主按钮与「取消」同一行、靠行尾,都是 sm;「取消」是 outline。 */}
      <div className="subscription-connection-form-actions">
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending
            ? translate('subscriptions.connections.saving')
            : cliAccount
              ? translate('subscriptions.connections.signIn')
              : kind === 'account'
                ? translate('subscriptions.connections.addAndSignIn')
                : translate('subscriptions.connections.save')}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="outline" disabled={create.isPending} onClick={onCancel}>
            {translate('agentsPage.cancel')}
          </Button>
        )}
      </div>
    </form>
  )
}

/** 接口的官方名字(专名,不翻译)—— 地址下那一行提示用。 */
const PROTOCOL_NAMES: Record<NonNullable<AgentConnectionForm['protocol']>, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-chat-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'gemini-generate-content': 'Gemini'
}

/** 地址成不成形(宿主那边要的是一个 http(s) URL):没成形就先不去读模型清单。 */
function isEndpointUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/** 没有官方地址可填的家才有占位(例子)。Claude 的地址是裸根、Codex 带 `/v1`;其余家照它要讲的接口:OpenAI 那两种带 `/v1`。 */
function endpointPlaceholder(providerId: string, protocol: AgentConnectionForm['protocol']): string {
  if (providerId === 'codex') return 'https://api.example.com/v1'
  if (protocol === 'openai-chat-completions' || protocol === 'openai-responses') return 'https://api.example.com/v1'
  return 'https://api.example.com'
}
