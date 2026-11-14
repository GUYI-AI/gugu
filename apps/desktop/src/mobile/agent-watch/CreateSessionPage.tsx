import type { FirstPrompt } from './use-timeline-session'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '@/lib/log'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import type { Device } from '@gugu/core/shared/types/chat'
import type {
  SessionpageSessionCreateModels,
  SessionpageSessionCreateOptions,
  SessionpageSessionSummary,
  SessionpageSessionCreateRequest,
  SessionpageSessionCreateResult,
} from '@gugu/session-core/session-record/contract'
import { Thread } from '@/components/assistant-ui/thread.aui'
import { ComposerExtrasProvider } from '@/components/assistant-ui/composer-extras'
import { Button } from '@/components/ui/Button'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import { useAuth } from '@/store/auth'
import { useDevicesStore } from '@/store/devicesContext'
import { rememberRunMachine, useProjectRunMachine } from '@renderer/features/projects/components/main-panel/project-run-machine'
import { forgetPhoneSessionCreate, readPhoneSessionCreate, rememberPhoneSessionCreate } from '../local-agent/phoneSessionCreate'
import { AgentWatchScreen } from './AgentWatchChrome'
import { LiveGlyph } from './StatusGlyph'
import { CreateOptionsPill } from './CreateOptionsPill'
import { useMachineLabel } from './useMachineLabel'
import { visibleMachines } from './machine-list'
import { accountProjects, createMachines, runCandidates } from './create-target'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { CreateTarget } from './CreateTarget'
import { ConnectionStatus } from '@/components/connection/ConnectionStatus'
import { connectionStateOf } from '@/components/connection/connectionState'
import { IconButton } from '@/components/ui/IconButton'
import { RefreshCw } from '@/lib/icons'
import { useCloudComputerWake } from '../../hooks/useWakeCloudComputer'
import { guguReasonInText, remoteFailureKind } from '@gugu/session-core/session-record/contract'
import { guguReasonText } from '@renderer/features/sessions/gugu-reason'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { SessionpageRpcError, createSession, fetchCreateModels, fetchCreateOptions, createPhoneSession, fetchPhoneCreateModels, fetchPhoneCreateOptions } from './sessionpage-rpc'
import { bindCreationDraft, mobileCreationDraftKey } from './create-session-draft'
import './task-flow-catalog'
import {
  createBlocker,
  createModelNeedsSignIn,
  initialSelection,
  lastUsedDropped,
  reconcileModel,
  toSessionSummary,
  type CreateSelection,
  type LastUsedItem,
} from './create-session-form'

const createLog = rendererLogger('mobile/agent-watch')

/** 「没沿用上」那句话里每一格叫什么 —— 与选项胶囊上的行名同一套词。 */
const LAST_USED_ITEM_LABEL_KEYS: Record<LastUsedItem, string> = {
  harness: 'agentWatch.create.harness',
  permissionMode: 'agentWatch.create.permissionLabel',
  model: 'agentWatch.create.model',
  effort: 'agentWatch.create.effort',
}

/**
 * 新建任务页:「+」直接进来(DESIGN 点击路径 4a,项目与机器解耦:项目是账号上的,机器只是这一次跑在哪)。
 *
 * owner 2026-09-06:「手机端的话,我建议是和你手机端会话一个输入框,然后是也 assistant 的组件」。所以:
 *   · 输入框上方「项目 · 机器」两行,都带默认值(CreateTarget;默认机器与桌面同一条规则);
 *   · 界面就是会话页那一套 —— 同一个官方 `Thread`、同一个输入框、同一颗选项胶囊(这里选的是
 *     harness · 模型),只是线程是空的。❌ 不再渲桌面会话页那张 composer:它是给 IDE 面画的。
 *   · 发送 = 建会话。建成直接跳进新会话的时间线,第一句话就在那儿。
 *
 * 发送失败**把那句话还给输入框**:assistant-ui 在发送时就清空了输入框,不还回去的话
 * 一次网络抖动就吞掉人打了半天的开场白 —— 那正是本仓禁止的「不持久化的输入」。
 */
function describe(err: unknown): string {
  if (err instanceof SessionpageRpcError) return `${err.message} (${err.code})`
  return err instanceof Error ? err.message : String(err)
}

type CreatedHandler = (session: SessionpageSessionSummary, firstPrompt: FirstPrompt | undefined, result?: SessionpageSessionCreateResult) => void

export function CreateSessionPage({
  taskGroup = null,
  onBack,
  onCreated,
}: {
  /** 群输入框的「新任务」(非项目群,同桌面 TaskDispatchComposer):首句落成这个群里的任务卡,agent 进群(chatId + taskChatId)。 */
  taskGroup?: { chatId: string; name: string } | null
  onBack?: () => void
  /** 建成了:带着建在哪台机器上、攒好的摘要与那句话跳进时间线。 */
  onCreated: (device: Device, ...created: Parameters<CreatedHandler>) => void
}) {
  const { t } = useTranslation('main')
  const { devices: hosts, phones, cloudComputer } = useDevicesStore()
  const { isHome, label: machineLabel } = useMachineLabel()
  const devices = useMemo(() => [...new Map([...hosts, ...(phones ?? [])].map((one) => [one.device_id, one])).values()], [hosts, phones])
  const machines = useMemo(() => visibleMachines(devices, isHome), [devices, isHome])
  // 账号上的项目(accountProjectsStore,桌面项目选择器同一份)。
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  const projects = useMemo(() => accountProjects(accountList, devices, cloudComputer?.snapshot?.deviceId ?? null), [accountList, devices, cloudComputer])
  // 默认不选项目(桌面 New task 同:`No project · 默认机器`)。
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const project = projects.find((one) => one.chatId === projectKey) ?? null
  const rows = useMemo(() => createMachines(project, machines), [project, machines])
  const runKey = project?.chatId ?? ''
  const { machine: machineId, pick } = useProjectRunMachine(runKey, runCandidates(rows, project), project?.chatId)
  const machine = rows.find((row) => row.device.device_id === machineId)
  const target = (busy: boolean) => (
    <CreateTarget projects={projects} project={project} onProject={setProjectKey} machines={rows} machine={machine} onMachine={pick} machineLabel={machineLabel} busy={busy} />
  )

  if (!machine) {
    return (
      <AgentWatchScreen title={t('agentWatch.create.title')} onBack={onBack} testId="agent-watch-create-page">
        <div className="gg-aw">{target(false)}</div>
      </AgentWatchScreen>
    )
  }
  return (
    <CreateOnMachine
      key={machine.device.device_id}
      device={machine.device}
      projectId={machine.localProjectId}
      target={target}
      taskGroup={taskGroup}
      onBack={onBack}
      onCreated={(...created) => {
        rememberRunMachine(project?.chatId, machine.device.device_id)
        onCreated(machine.device, ...created)
      }}
    />
  )
}

/** 在选定的这台机器上开:换机器 = 换一份(key),那台的选项、模型目录、未确认的手机创建各读各的。 */
function CreateOnMachine({
  device,
  projectId,
  target,
  taskGroup,
  onBack,
  onCreated,
}: {
  device: Device
  /** 选了项目时那台机器上的本地项目;null = 不选项目(那台的任务工作区)。手机任务宿主用它自己报的那个项目。 */
  projectId: string | null
  /** 输入框上方的「项目 · 机器」两行;`busy` = 建着 / 有未确认的创建,不让换。 */
  target: (busy: boolean) => ReactNode
  taskGroup: { chatId: string; name: string } | null
  onBack?: () => void
  /** firstPrompt: absent only when retrying a stored phone attempt from before the first prompt carried its id. */
  onCreated: CreatedHandler
}) {
  const { t } = useTranslation('main')
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  const { t: tc } = useTranslation('common')
  const { label: machineLabel } = useMachineLabel()
  const ownerId = useAuth().user?.id ?? null
  const phone = isPhoneDevice(device)
  const online = device.is_online && (!phone || isAgentHostDevice(device))
  const draft = useRef<ReturnType<typeof bindCreationDraft> | null>(null)
  // Completion still settles the real request after leaving; only this page may navigate or alter its composer.
  const page = useMemo(() => ({ active: true, deviceId: device.device_id, ownerId }), [device.device_id, ownerId])
  useEffect(() => {
    page.active = true
    return () => { page.active = false }
  }, [page])
  // #7199 在睡着的云电脑上新建 = 叫醒它;醒了(在线)选项照常读出来。
  const { issue: wakeIssue, dropped: wakeDropped, retry: retryWake } = useCloudComputerWake(device)
  const [options, setOptions] = useState<SessionpageSessionCreateOptions | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [selection, setSelection] = useState<CreateSelection>({ harness: null, model: null, permissionMode: null, effort: null })
  /** 人动过选择没有 —— 动过之后「上次那一套没沿用上」就不再说(那是人自己的改动)。 */
  const [touched, setTouched] = useState(false)
  /** 与桌面创建框同一条：明确点选的自家默认不被自动默认覆盖；换 harness 后重算。 */
  const modelTouched = useRef(false)
  /** 选定 harness 的模型目录；自动默认等这份读数，人明确点选后沿用其选择。 */
  const [models, setModels] = useState<SessionpageSessionCreateModels | null>(null)
  const [modelsState, setModelsState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  /** 正在建的那句话;建成或失败后清空。它同时也是线程里唯一那条(乐观显示的)用户消息。 */
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [phoneAttempt, setPhoneAttempt] = useState<SessionpageSessionCreateRequest | null>(null)

  // 机器离线时**不发 RPC**(与会话页同一条):发过去只会等到超时,而超时长得像「机器没响应」。
  useEffect(() => {
    setOptions(null)
    setOptionsError(null)
    if (!online) return
    let cancelled = false
    setTouched(false)
    const readOptions = phone ? fetchPhoneCreateOptions : fetchCreateOptions
    readOptions(device.device_id)
      .then((next) => {
        if (cancelled) return
        const attempt = phone && ownerId ? readPhoneSessionCreate(ownerId, device.device_id) : null
        modelTouched.current = attempt !== null
        setPhoneAttempt(attempt)
        setOptions(next)
        setSelection(attempt ? { ...initialSelection(next), harness: attempt.harness, model: attempt.model ?? null } : initialSelection(next))
      })
      .catch((err) => { if (!cancelled) setOptionsError(describe(err)) })
    return () => { cancelled = true }
  }, [device.device_id, online, reloadKey, phone, ownerId])

  // 目录跟着 harness 走；复用这次读数定默认，不另发可用性探针。
  // 展示不由手机选:那台电脑按自己的「终端」开关定。
  const harness = selection.harness
  const model = selection.model
  useEffect(() => {
    if (!online || !harness) { setModels(null); setModelsState('idle'); return }
    let cancelled = false
    // 推理档跟着模型走(桌面同一条),所以换模型也重读;但同一家同一腿只是换模型时**不清空**清单 ——
    // 清了列表会在人刚点完那一下闪没,而且 reconcile 会把刚选的模型判成「不在目录里」清掉。
    setModels((prev) => (prev && prev.harness === harness ? prev : null))
    setModelsState('loading')
    const readModels = phone ? fetchPhoneCreateModels : fetchCreateModels
    readModels(device.device_id, harness, null, model)
      .then((next) => {
        if (cancelled) return
        setModels(next)
        setModelsState('ready')
        setSelection((current) => reconcileModel(current, next, modelTouched.current, options?.lastUsed))
      })
      .catch(() => { if (!cancelled) setModelsState('failed') })
    return () => { cancelled = true }
  }, [device.device_id, online, harness, model, reloadKey, phone, options])

  const blocker = options ? createBlocker(options, selection) : null
  const readingModelDefault = !modelTouched.current && (!models || models.harness !== harness) && modelsState !== 'failed'
  const modelNeedsSignIn = !phoneAttempt && createModelNeedsSignIn(selection, models)
  const modelNotice = modelNeedsSignIn ? t('agentWatch.create.modelHarnessState.auth-required') : readingModelDefault ? t('agentWatch.create.modelLoading') : null
  const creating = pendingText !== null
  const canSubmit = online && options !== null && optionsError === null && blocker === null && !readingModelDefault && !modelNeedsSignIn
  const reloadOptions = () => {
    setOptions(null)
    setOptionsError(null)
    setReloadKey((key) => key + 1)
  }

  const messages = useMemo<ThreadMessageLike[]>(
    () => (pendingText ? [{ role: 'user', content: [{ type: 'text', text: pendingText }] }] : []),
    [pendingText],
  )

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    isRunning: creating,
    messages,
    convertMessage: (message) => message,
    onNew: async (message: AppendMessage) => {
      const first = message.content[0]
      if (!first || first.type !== 'text') throw new Error(t('agentWatch.composer.textOnly'))
      const text = first.text.trim()
      const submittedDraft = draft.current
      submittedDraft?.hold(first.text)
      // 还没读到选项 / 还有拦着的原因 → 如实报,❌ 不带着空 projectId 发过去让机器来拒。
      if (!online || !options || optionsError || blocker || readingModelDefault || modelNeedsSignIn) {
        setCreateError(blocker ? t(`agentWatch.create.blocked.${blocker}`) : modelNotice ?? t('agentWatch.create.blocked.loading'))
        runtime.thread.composer.setText(first.text)
        submittedDraft?.restore(first.text)
        return
      }
      setCreateError(null)
      setPendingText(text)
      const sentAt = Date.now()
      let submittedPhoneRequest: SessionpageSessionCreateRequest | null = null
      try {
        if (phone && !ownerId) throw new Error('请先登录后创建 Agent')
        if (phoneAttempt && phoneAttempt.prompt !== text) throw new Error('上次创建尚未确认，请先发送原来的任务以继续同一次创建')
        const request: SessionpageSessionCreateRequest = phoneAttempt ?? {
          ...(phone ? { clientRequestId: crypto.randomUUID() } : {}),
          // 手机任务宿主跑它自己报的那个项目;电脑上不带 = 那台的任务工作区。
          ...(phone ? (options.projects[0] ? { projectId: options.projects[0].id } : {}) : projectId ? { projectId } : {}),
          harness: selection.harness!,
          prompt: text,
          // The host admits the first prompt under this id; the page's optimistic first bubble uses the same one.
          initialMessageId: crypto.randomUUID(),
          ...(selection.model ? { model: selection.model } : {}),
          ...(selection.permissionMode ? { permissionMode: selection.permissionMode } : {}),
          ...(selection.effort ? { effort: selection.effort } : {}),
          ...(taskGroup ? { chatId: taskGroup.chatId, taskChatId: taskGroup.chatId } : {}),
        }
        if (phone) {
          rememberPhoneSessionCreate(ownerId!, device.device_id, request)
          submittedPhoneRequest = request
          setPhoneAttempt(request)
        }
        const result = await (phone ? createPhoneSession : createSession)(device.device_id, request)
        if (phone) {
          if (!result.session?.supported || result.session.conversationId !== result.conversationId) throw new Error('手机尚未返回完整的任务记录，请继续同一次创建')
          forgetPhoneSessionCreate(ownerId!, device.device_id, request)
          if (page.active) setPhoneAttempt(null)
        }
        submittedDraft?.accepted(text)
        if (page.active) onCreated(result.session ?? toSessionSummary(result, selection.harness!, new Date().toISOString()), request.initialMessageId ? { id: request.initialMessageId, text, sentAt } : undefined, result)
      } catch (err) {
        // 机器那边装 agent 没装成:原因进日志,人看到的是能照做的下一步(按本端语言,❌ 机器那边拼的双语原文)。
        // 其余原因同理:按原因码归类说人话(remoteFailureKind),原文只进日志。
        createLog.warn({ error: String(err) }, 'create session failed')
        const code = err instanceof SessionpageRpcError ? err.code : err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null
        if (phone && ownerId && submittedPhoneRequest && code === 'phone_create_rejected') {
          // The host explicitly proved it rejected before any durable provision was admitted.
          forgetPhoneSessionCreate(ownerId, device.device_id, submittedPhoneRequest)
          if (page.active) setPhoneAttempt(null)
        }
        if (!page.active) return
        setPendingText(null)
        // 签咕咕额度被拒:那台机器报的是原因码(#7103),按原因说(与新建框咕咕那一组同一份文案)。
        const gugu = guguReasonInText(code)
        setCreateError(phone ? describe(err) : code === 'harness_install_failed'
          ? t('agentWatch.create.agentInstallFailed')
          : code === 'harness_runtime_missing'
            ? t('agentWatch.create.agentRuntimeMissing')
            : gugu
              ? guguReasonText(gugu, translateSessionMessage)
              : t(`agentWatch.create.failure.${remoteFailureKind(code)}`))
        // 把那句话还回去。assistant-ui 发送时已经清空了输入框,这一步不做就等于吞掉用户输入。
        submittedDraft?.restore(phoneAttempt?.prompt ?? first.text)
        if (!submittedDraft && !runtime.thread.composer.getState().text) runtime.thread.composer.setText(phoneAttempt?.prompt ?? first.text)
      }
    },
  })

  useEffect(() => {
    if (!ownerId) return
    const binding = bindCreationDraft(runtime.thread.composer, mobileCreationDraftKey(ownerId))
    draft.current = binding
    return () => {
      binding.dispose()
      if (draft.current === binding) draft.current = null
    }
  }, [ownerId, runtime.thread.composer])

  useEffect(() => {
    if (phoneAttempt && pendingText === null && !runtime.thread.composer.getState().text) runtime.thread.composer.setText(phoneAttempt.prompt)
  }, [phoneAttempt, pendingText, runtime.thread.composer])

  // The empty thread stays empty: the rows above the composer already say where it runs (no helper sentence).
  const Welcome = useMemo(() => function CreateWelcome() { return <div className="aui-thread-welcome-root gg-aw-create-intro" /> }, [])

  const errorNotice = createError ? (
    <div
      className="gg-aw-action-error"
      data-testid="agent-watch-create-error"
      role="alert"
      aria-live="assertive"
    >
      <span className="gg-aw-action-error-title">{t('agentWatch.create.failed')}</span>
      <span className="gg-aw-action-error-detail">{createError}</span>
      <Button
        variant="ghost"
        size="sm"
        data-testid="agent-watch-create-error-dismiss"
        onClick={() => setCreateError(null)}
      >
        {t('agentWatch.composer.dismiss')}
      </Button>
    </div>
  ) : null

  // 「为什么还不能发」钉在输入框上方,与失败横幅同一位置 —— 人看输入框时它就在眼前。
  // ⚠️ 这是**说明**,不是错误:机器上没项目是常态,❌ 不用报错的红。
  const blockerNotice = options && (blocker || modelNotice) ? (
    <div className="gg-aw-create-blocker" data-testid="agent-watch-create-blocker" data-blocker={blocker ?? (modelNeedsSignIn ? 'model_auth_required' : 'loading_model')}>
      {blocker ? t(`agentWatch.create.blocked.${blocker}`) : modelNotice}
    </div>
  ) : null
  const pendingCreationNotice = phoneAttempt && !creating ? (
    <div className="gg-aw-create-blocker" role="status" data-testid="agent-watch-create-pending">
      <div>{tFlow('pendingCreation')}</div>
      <details>
        <summary className="min-h-[var(--control-h-touch)] cursor-pointer py-3">{tFlow('originalTask')}</summary>
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{phoneAttempt.prompt}</div>
      </details>
    </div>
  ) : null
  const optionsNotice = online && (!options || optionsError) ? (
    <div className={optionsError ? 'gg-aw-action-error' : 'gg-aw-create-blocker gg-aw-create-birth-group'} role={optionsError ? 'alert' : 'status'} data-testid={optionsError ? 'agent-watch-create-options-error' : 'agent-watch-create-options-loading'}>
      <span>{optionsError ? t('agentWatch.create.optionsFailed') : t('agentWatch.create.loadingOptions')}</span>
      {optionsError ? <span className="gg-aw-action-error-detail">{optionsError}</span> : null}
      <Button variant="ghost" size="sm" onClick={reloadOptions} data-testid="agent-watch-create-options-retry">{t('agentWatch.timeline.reload')}</Button>
    </div>
  ) : null

  // 派到哪个群里:与上面同一种说明口气。
  const requestedGroup = phoneAttempt ? phoneAttempt.chatId : taskGroup?.chatId
  const groupName = requestedGroup === taskGroup?.chatId ? taskGroup?.name : '上次的群聊'
  const taskGroupNotice = requestedGroup ? (
    <div className="gg-aw-create-blocker gg-aw-create-birth-group" data-testid="agent-watch-create-task-group">
      <span>{t('agentWatch.create.taskGroup', { name: groupName })}</span>
    </div>
  ) : null

  // 上次那一套有几格这次没沿用上:说一句为什么变了(behavior mobile-session-view),与上面那句同一种说明口气。
  const dropped = options && !touched ? lastUsedDropped(options, selection) : []
  const lastUsedNotice = dropped.length > 0 ? (
    <div className="gg-aw-create-blocker" data-testid="agent-watch-create-last-used" data-dropped={dropped.join(' ')}>
      {t('agentWatch.create.lastUsedDropped', {
        items: dropped.map((item) => t(LAST_USED_ITEM_LABEL_KEYS[item])).join(t('agentWatch.create.lastUsedJoiner')),
      })}
    </div>
  ) : null

  /*
   * 「正在开会话 / 正在读选项」摆在页头状态位(与会话页页头的状态词同一个位置),
   * ❌ 不再在输入框上方另起一条带子 —— 那一行把输入框往上顶、和页头各说一半(owner 2026-09-24 真机)。
   * 选项还没读回来时仍要说一句:机器端刚重启要做全机依赖探测,可能几十秒,
   * 不说「在读」,页面与「什么都选不了」长得一模一样(owner 2026-09-15 真机)。
   */
  const busyLabel = creating
    ? t('agentWatch.create.creating')
    : online && !options && !optionsError
      ? t('agentWatch.create.loadingOptions')
      : null
  // Not reachable: the machine's state is the header subtitle (owner 11-08), ❌ a line under the header.
  const cloudAsleep = device.cloud_computer === 'asleep' || device.cloud_computer === 'waking'
  const wakeFailed = cloudAsleep && wakeIssue !== null
  const connection = online ? 'online' as const : connectionStateOf({ deviceOnline: false, cloudWaking: cloudAsleep, cloudWakeFailed: wakeFailed })
  const subtitle = connection !== 'online' ? (
    <ConnectionStatus
      state={connection}
      subject={machineLabel(device)}
      lastSeenAt={device.last_seen_at}
      detail={wakeFailed && wakeIssue ? tc(`cloudComputer.reason.${wakeIssue.kind}`) : null}
      testId="agent-watch-connection-status"
    />
  ) : busyLabel ? (
    <span className="gg-aw-head-status" role="status" data-testid="agent-watch-create-status">
      <LiveGlyph state="busy" />
      <span>{busyLabel}</span>
    </span>
  ) : null

  return (
    <AgentWatchScreen
      title={t('agentWatch.create.title')}
      subtitle={subtitle}
      actions={cloudAsleep && (wakeIssue || wakeDropped) ? (
        <IconButton size="md" aria-label={tc('connection.retry')} title={tc('connection.retry')} data-testid="agent-watch-cloud-computer-retry" onClick={retryWake}>
          <RefreshCw />
        </IconButton>
      ) : undefined}
      onBack={onBack}
      testId="agent-watch-create-page"
      bodyFill
    >
        <AssistantRuntimeProvider runtime={runtime}>
          <div className="gg-aw-thread-host gg-aw-create-host" data-testid="agent-watch-create-thread">
            <ComposerExtrasProvider
              placeholder={t('agentWatch.create.placeholder')}
              extras={
                options ? (
                  <CreateOptionsPill
                    phoneHost={phone}
                    options={options}
                    selection={selection}
                    onChange={(next, modelPicked) => {
                      modelTouched.current = next.harness === selection.harness && (modelTouched.current || modelPicked === true)
                      setTouched(true)
                      setSelection(next)
                    }}
                    busy={!online || optionsError !== null || creating || phoneAttempt !== null}
                    models={models}
                    modelsState={modelsState}
                  />
                ) : null
              }
              above={
                <div className="gg-aw-thread-extras">
                  {errorNotice}
                  {optionsNotice}
                  {blockerNotice}
                  {pendingCreationNotice}
                  {lastUsedNotice}
                  {taskGroupNotice}
                  {target(creating || phoneAttempt !== null)}
                </div>
              }
            >
              <Thread components={{ Welcome }} autoFocus={false} submitOnEnter={false} sendDisabled={!canSubmit} />
            </ComposerExtrasProvider>
          </div>
        </AssistantRuntimeProvider>
    </AgentWatchScreen>
  )
}
