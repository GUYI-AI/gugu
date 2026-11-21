import { cloudSnapshotOf, useCloudComputer } from '@/lib/cloudComputer'
import type { FirstPrompt } from '../../components/session-watch/use-timeline-session'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import type { Device } from '@gugu/core/shared/types/chat'
import type {
  SessionpageSessionCreateModels,
  SessionpageSessionSummary,
  SessionpageSessionCreateRequest,
  SessionpageSessionCreateResult,
} from '@gugu/session-core/session-record/contract'
import type { PromptEditorRef } from '@gugu/session-ui/react/components'
import { Thread, ThreadComposer } from '@/components/assistant-ui/thread.aui'
import { ComposerExtrasProvider } from '@/components/assistant-ui/composer-extras'
import { Button } from '@/components/ui/Button'
import { RefreshFailed } from '@/components/ui/RefreshFailed'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import { useAuth } from '@/store/auth'
import { useDevicesStore } from '@/store/devicesContext'
import { rememberRunMachine, useProjectRunMachine } from '@renderer/features/projects/components/main-panel/project-run-machine'
import { forgetPhoneSessionCreate, readPhoneSessionCreate, rememberPhoneSessionCreate } from '../local-agent/phoneSessionCreate'
import { AgentWatchScreen } from '../../components/session-watch/AgentWatchChrome'
import { LiveGlyph } from '../../components/session-watch/StatusGlyph'
import { creationSkillInput } from '../../components/session-watch/create-skill-draft'
import { useMachineLabel } from '../../components/session-watch/useMachineLabel'
import { visibleMachines } from '../../components/session-watch/machine-list'
import { accountProjects, createMachines, runCandidates } from '../../components/session-watch/create-target'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { CreateTarget, type CreationConfiguration } from '../../components/session-watch/CreateTarget'
import { PhoneHostSetupEntry } from '../../components/session-watch/PhoneHostSetupEntry'
import { ConnectionStatus } from '@/components/connection/ConnectionStatus'
import { connectionStateOf } from '@/components/connection/connectionState'
import { IconButton } from '@/components/ui/IconButton'
import { RefreshCw } from '@/lib/icons'
import { useCloudComputerWake } from '../../hooks/useWakeCloudComputer'
import { guguReasonInText, remoteFailureKind } from '@gugu/session-core/session-record/contract'
import { guguReasonText } from '@renderer/features/sessions/gugu-reason'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { SessionpageRpcError, createSession, createPhoneSession } from '../../components/session-watch/sessionpage-rpc'
import { refreshFailure, useReplica } from '@/lib/replica'
import { sessionCreateModels, sessionCreateOptions } from '@/lib/agentModelReplicas'
import { bindCreationDraft, mobileCreationDraftKey } from './create-session-draft'
import { createAttachmentDraftAdapter } from './create-attachment-adapter'
import { creationThinking } from '../../components/session-watch/creation-thinking'
import { creationAttachmentPorts } from './create-attachment-rpc'
import { creationFailureDiagnostic } from './create-failure-diagnostic'
import { completeAttachmentCreation, readAttachmentCreation, readAttachmentCreationDevice, submitAttachmentCreation } from './create-attachment-submission'
import { PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { usePhoneProjectTaskFolder } from '../chat/usePhoneProjectTaskFolder'
import '../../components/session-watch/task-flow-catalog'
import '../../components/session-watch/agent-watch.css'
import {
  createBlocker,
  createModelNeedsSignIn,
  initialSelection,
  lastUsedDropped,
  reconcileModel,
  submittedCreationSelection,
  toSessionSummary,
  type CreateSelection,
  type LastUsedItem,
} from '../../components/session-watch/create-session-form'

const createLog = rendererLogger('mobile/agent-watch')
/** Before the machine's options are read nothing is picked (the options pill is not drawn until they are). */
const NO_SELECTION: CreateSelection = { harness: null, model: null, permissionMode: null, effort: null }

/** 「没沿用上」那句话里每一格叫什么 —— 与选项胶囊上的行名同一套词。 */
const LAST_USED_ITEM_LABEL_KEYS: Record<LastUsedItem, string> = {
  harness: 'agentWatch.create.harness',
  permissionMode: 'agentWatch.create.permissionLabel',
  model: 'agentWatch.create.model',
  effort: 'agentWatch.create.effort',
}

/** Phone creation keeps the session composer and draft, with target controls above it. */
function describe(err: unknown): string {
  if (err instanceof SessionpageRpcError) return `${err.message} (${err.code})`
  return err instanceof Error ? err.message : String(err)
}

type CreatedHandler = (session: SessionpageSessionSummary, firstPrompt: FirstPrompt | undefined, result?: SessionpageSessionCreateResult) => void

type TaskGroup = { chatId: string; name: string }
type CreateSessionPageProps = {
  onBack?: () => void
  onCreated: (device: Device, ...created: Parameters<CreatedHandler>) => void
}
type GroupSheet = { group: TaskGroup; onClose: () => void }

export function CreateSessionPage(props: CreateSessionPageProps) {
  return <CreateSessionForm {...props} />
}

export function CreateSessionSheet({ group, onClose, onCreated }: GroupSheet & Pick<CreateSessionPageProps, 'onCreated'>) {
  const { t } = useTranslation('messaging')
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  return <PhoneComposerSheet open onClose={onClose} title={t('chatList.createAgent')}
    testId="phone-group-agent-sheet" className="gg-phone-group-agent-sheet">
    <div className="gg-phone-group-agent-destination" data-testid="phone-group-agent-destination">
      <span>{tFlow('sendToGroup')}</span><span>{group.name}</span>
    </div>
    <CreateSessionForm taskGroup={group} onCreated={onCreated} />
  </PhoneComposerSheet>
}

function CreateSessionForm({ taskGroup = null, onBack, onCreated }: CreateSessionPageProps & { taskGroup?: TaskGroup | null }) {
  const inSheet = taskGroup !== null
  const { t } = useTranslation('main')
  const ownerId = useAuth().user?.id ?? null
  const { devices: hosts, phones } = useDevicesStore()
  const cloudComputer = useCloudComputer()
  const { isHome, label: machineLabel } = useMachineLabel()
  const devices = useMemo(() => [...new Map([...hosts, ...(phones ?? [])].map((one) => [one.device_id, one])).values()], [hosts, phones])
  const machines = useMemo(() => visibleMachines(devices, isHome), [devices, isHome])
  // 账号上的项目(accountProjectsStore,桌面项目选择器同一份)。
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  const projects = useMemo(() => accountProjects(accountList, devices, cloudSnapshotOf(cloudComputer)?.deviceId ?? null), [accountList, devices, cloudComputer])
  // 默认不选项目(桌面 New task 同:`No project · 默认机器`)。
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const project = projects.find((one) => one.chatId === projectKey) ?? null
  const rows = useMemo(() => createMachines(project, machines), [project, machines])
  const runKey = project?.chatId ?? ''
  const { machine: machineId, pick } = useProjectRunMachine(runKey, runCandidates(rows, project), project?.chatId)
  const draftKey = ownerId ? mobileCreationDraftKey(ownerId, taskGroup?.chatId) : null
  const submittedDeviceId = draftKey ? readAttachmentCreationDevice(draftKey) : null
  const projectTask = usePhoneProjectTaskFolder(taskGroup?.chatId)
  const machine = projectTask ? projectTask.machine : rows.find(row => row.device.device_id === (submittedDeviceId ?? machineId))
  const previousMachine = useRef<typeof machine>(undefined)
  const previousOwner = useRef(ownerId)
  if (previousOwner.current !== ownerId) { previousOwner.current = ownerId; previousMachine.current = undefined }
  if (machine) previousMachine.current = machine
  const editingMachine = machine ?? (submittedDeviceId && previousMachine.current?.device.device_id !== submittedDeviceId ? undefined : previousMachine.current)
  const targetMachines = projectTask ? (machine ? [machine] : []) : rows
  const target = (busy: boolean, configuration?: CreationConfiguration) => (
    <CreateTarget projects={projects} project={project} onProject={setProjectKey} machines={targetMachines} machine={machine} onMachine={pick} machineLabel={machineLabel}
      conversationKey={`create:${ownerId ?? 'signed-out'}:${taskGroup?.chatId ?? ''}`}
      busy={busy} configuration={configuration} projectTask={projectTask?.control} scopeChatId={taskGroup?.chatId ?? project?.chatId ?? null} />
  )

  if (!editingMachine) {
    if (inSheet) return <div className="gg-aw gg-phone-group-agent-form">
      {target(false)}{projectTask ? projectTask.overlay : <PhoneHostSetupEntry />}
    </div>
    return (
      <AgentWatchScreen title={t('agentWatch.create.title')} onBack={onBack} testId="agent-watch-create-page">
        <div className="gg-aw">{target(false)}<PhoneHostSetupEntry /></div>
      </AgentWatchScreen>
    )
  }
  return (
    <CreateOnMachine
      key={ownerId ?? 'signed-out'}
      device={editingMachine.device}
      projectId={machine?.localProjectId ?? null}
      targetAvailable={!!machine && (!projectTask || machine.available)}
      cwd={projectTask?.machine?.path ?? undefined}
      draftKey={draftKey}
      overlay={projectTask?.overlay}
      target={target}
      taskGroup={taskGroup}
      onBack={onBack}
      onCreated={(...created) => {
        rememberRunMachine(projectTask ? taskGroup?.chatId : project?.chatId, editingMachine.device.device_id)
        onCreated(editingMachine.device, ...created)
      }}
    />
  )
}

/** Device choices change catalogs while retaining the existing composer and native composition. */
function CreateOnMachine({
  device,
  projectId,
  cwd,
  draftKey,
  overlay,
  target,
  targetAvailable,
  taskGroup,
  onBack,
  onCreated,
}: {
  device: Device
  /** 选了项目时那台机器上的本地项目;null = 不选项目(那台的任务工作区)。手机任务宿主用它自己报的那个项目。 */
  projectId: string | null
  /** The shared control row is locked while a creation is in flight or unconfirmed. */
  target: (busy: boolean, configuration?: CreationConfiguration) => ReactNode
  targetAvailable: boolean
  cwd?: string
  draftKey: string | null
  overlay?: ReactNode
  taskGroup: TaskGroup | null
  onBack?: () => void
  /** firstPrompt: absent only when retrying a stored phone attempt from before the first prompt carried its id. */
  onCreated: CreatedHandler
}) {
  const { t } = useTranslation('main')
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  const { t: tc } = useTranslation('common')
  const inSheet = taskGroup !== null
  const { label: machineLabel } = useMachineLabel()
  const ownerId = useAuth().user?.id ?? null
  const phone = isPhoneDevice(device)
  const online = targetAvailable && device.is_online && (!phone || isAgentHostDevice(device))
  const draft = useRef<ReturnType<typeof bindCreationDraft> | null>(null)
  // Completion still settles the real request after leaving; only this page may navigate or alter its composer.
  const page = useMemo(() => ({ active: true, deviceId: device.device_id, ownerId }), [device.device_id, ownerId])
  useEffect(() => {
    page.active = true
    return () => { page.active = false }
  }, [page])
  // #7199 在睡着的云电脑上新建 = 叫醒它;醒了(在线)选项照常读出来。
  const { issue: wakeIssue, dropped: wakeDropped, retry: retryWake } = useCloudComputerWake(targetAvailable ? device : null)
  const catalogKey = JSON.stringify([ownerId, device.device_id, phone])
  const via = phone ? 'phone' as const : 'machine' as const
  // 机器离线时不发 RPC(与会话页同一条):发过去只会等到超时,而超时长得像「机器没响应」。
  const optionsReading = useReplica(sessionCreateOptions, online ? [device.device_id, via] : null)
  const options = optionsReading.state === 'value' ? optionsReading.value : null
  const optionsError = optionsReading.state === 'error' ? describe(optionsReading.error) : null
  // Read before, read again failed: the options stay offered, the failure is said with the same retry (❌ shown as current).
  const optionsFailure = refreshFailure(optionsReading)
  /** 没确认完的那次创建(本机发件记录,同步读):带附件的那一次,或手机上的那一次;沿用它的选择,发的也只能是它。 */
  const attachmentAttempt = draftKey ? readAttachmentCreation(draftKey) : null
  const storedAttempt = useMemo(() => phone && ownerId ? readPhoneSessionCreate(ownerId, device.device_id) : null, [phone, ownerId, device.device_id])
  const [attempt, setAttempt] = useState<{ key: string; value: SessionpageSessionCreateRequest | null } | null>(null)
  const phoneAttempt = attempt?.key === catalogKey ? attempt.value : storedAttempt
  const setPhoneAttempt = (value: SessionpageSessionCreateRequest | null) => setAttempt({ key: catalogKey, value })
  const submittedAttempt = attachmentAttempt ?? phoneAttempt
  const attachmentAdapter = useMemo(() => draftKey ? createAttachmentDraftAdapter(draftKey) : undefined, [draftKey])
  const [choice, setChoice] = useState<{ key: string; value: CreateSelection | null } | null>(null)
  const chosen = choice?.key === catalogKey ? choice.value : null
  const setChosen = (value: CreateSelection | null) => setChoice({ key: catalogKey, value })
  /** 人动过选择没有 —— 动过之后「上次那一套没沿用上」就不再说(那是人自己的改动)。 */
  const touched = chosen !== null
  /** 与桌面创建框同一条：明确点选的自家默认不被自动默认覆盖；换 harness 后重算。 */
  const modelTouched = useRef(submittedAttempt !== null)
  const modelScope = useRef(catalogKey)
  if (modelScope.current !== catalogKey) { modelScope.current = catalogKey; modelTouched.current = submittedAttempt !== null }
  const derived = options ? (submittedAttempt ? submittedCreationSelection(submittedAttempt) : initialSelection(options)) : null
  const picked = chosen ?? derived ?? NO_SELECTION
  // 展示不由手机选:那台电脑按自己的「终端」开关定。
  const harness = picked.harness
  const model = picked.model
  const modelsReading = useReplica(sessionCreateModels, online && harness ? [device.device_id, harness, null, model, via] : null)
  // 同一家同一腿只是换模型时**不清空**清单(清了会闪没,reconcile 还会把刚选的模型清掉):新读数到之前画上一份。
  const [keptModels, setKeptModels] = useState<{ key: string; value: SessionpageSessionCreateModels } | null>(null)
  const lastModels = keptModels?.key === catalogKey ? keptModels.value : null
  if (modelsReading.state === 'value' && modelsReading.value !== lastModels) setKeptModels({ key: catalogKey, value: modelsReading.value })
  const models = modelsReading.state === 'value' ? modelsReading.value : lastModels && lastModels.harness === harness ? lastModels : null
  const modelsState: 'idle' | 'loading' | 'ready' | 'failed' = !online || !harness ? 'idle' : modelsReading.state === 'value' ? 'ready' : modelsReading.state === 'error' ? 'failed' : 'loading'
  // A submitted creation is sent as it was: its selection stays (the controls are locked meanwhile).
  const selection = submittedAttempt && !chosen ? picked : reconcileModel(picked, models, modelTouched.current, options?.lastUsed)
  /** 正在建的那句话;建成或失败后清空。它同时也是线程里唯一那条(乐观显示的)用户消息。 */
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  // Opening the model menu reads the list again (what the machine offers may have changed since).
  const refreshModelList = () => {
    if (!online || !harness || modelsReading.state === 'unknown') return
    // The menu only needs the list: the directory entry (no model) is read again, its list put into the entry shown.
    // Reading the selected model's entry again would run its effort probe again.
    const shown = sessionCreateModels.at(device.device_id, harness, null, model, via)
    const directory = [device.device_id, harness, null, null, via] as const
    void sessionCreateModels.refresh(...directory)
      .then(() => sessionCreateModels.fetch(...directory))
      .then((next) => {
        if (model === null) return
        shown.set((current) => current && {
          ...current, models: next.models, harnessState: next.harnessState, harnessReason: next.harnessReason, guguReason: next.guguReason,
        })
      }, () => undefined)
  }

  const blocker = options ? createBlocker(options, selection) : null
  const readingModelDefault = (!!cwd || !modelTouched.current) && (!models || models.harness !== harness) && modelsState !== 'failed'
  const modelNeedsSignIn = !phoneAttempt && createModelNeedsSignIn(selection, models)
  const modelReadFailed = !!cwd && modelsState === 'failed' && !models
  const modelNotice = modelReadFailed ? tFlow('modelCatalogFailed') : modelNeedsSignIn ? t('agentWatch.create.modelHarnessState.auth-required') : readingModelDefault ? t('agentWatch.create.modelLoading') : null
  const creating = pendingText !== null
  // The native retry journal is device-wide. A different group must never resume that request.
  const otherGroupAttempt = inSheet && phoneAttempt !== null && phoneAttempt.chatId !== taskGroup?.chatId
  const canSubmit = !otherGroupAttempt && !modelReadFailed && online && options !== null && optionsError === null && blocker === null && !readingModelDefault && !modelNeedsSignIn
  const reloadOptions = () => {
    setChosen(null)
    void sessionCreateOptions.refresh(device.device_id, via)
    if (harness) void sessionCreateModels.refresh(device.device_id, harness)
  }

  const messages = useMemo<ThreadMessageLike[]>(
    () => (pendingText ? [{ role: 'user', content: [{ type: 'text', text: pendingText }] }] : []),
    [pendingText],
  )

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    isRunning: creating,
    adapters: { attachments: attachmentAdapter },
    messages,
    convertMessage: (message) => message,
    onNew: async (message: AppendMessage) => {
      const originalText = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      const files = message.attachments ?? []
      const typedText = originalText.trim()
      const text = typedText
      const submittedDraft = draft.current
      submittedDraft?.hold(originalText, files)
      // 还没读到选项 / 还有拦着的原因 → 如实报,❌ 不带着空 projectId 发过去让机器来拒。
      if (!online || !options || optionsError || blocker || readingModelDefault || modelNeedsSignIn || modelReadFailed || otherGroupAttempt) {
        setCreateError(blocker ? t(`agentWatch.create.blocked.${blocker}`) : modelNotice ?? t('agentWatch.create.blocked.loading'))
        runtime.thread.composer.setText(originalText)
        await submittedDraft?.restore(originalText, files)
        return
      }
      setCreateError(null)
      setPendingText(text)
      const sentAt = Date.now()
      let submittedPhoneRequest: SessionpageSessionCreateRequest | null = null
      try {
        if ((phone || files.length) && !ownerId) throw new Error(tFlow('errors.signInToCreate'))
        if (attachmentAttempt && !files.length) throw Object.assign(new Error('Original creation attachments are required'), { code: 'creation_attachments_pending' })
        if (phoneAttempt && phoneAttempt.prompt !== text) throw new Error(tFlow('errors.sendOriginalFirst'))
        let request: SessionpageSessionCreateRequest = attachmentAttempt ?? phoneAttempt ?? {
          ...(phone ? { clientRequestId: crypto.randomUUID() } : {}),
          // 手机任务宿主跑它自己报的那个项目;电脑上不带 = 那台的任务工作区。
          ...(phone ? (options.projects[0] ? { projectId: options.projects[0].id } : {}) : projectId ? { projectId } : {}),
          ...(cwd ? { cwd } : {}),
          harness: selection.harness!,
          prompt: text,
          // The host admits the first prompt under this id; the page's optimistic first bubble uses the same one.
          initialMessageId: crypto.randomUUID(),
          ...(selection.model ? { model: selection.model } : {}),
          ...(selection.permissionMode ? { permissionMode: selection.permissionMode } : {}),
          ...(selection.effort ? { effort: selection.effort } : {}),
          ...(creationThinking(models, selection).fastMode !== undefined ? { fastMode: creationThinking(models, selection).fastMode } : {}),
          ...(taskGroup ? { chatId: taskGroup.chatId, taskChatId: taskGroup.chatId } : {}),
        }
        if (phone && !files.length) {
          rememberPhoneSessionCreate(ownerId!, device.device_id, request)
          submittedPhoneRequest = request
          setPhoneAttempt(request)
        }
        let attachmentReceipt: Awaited<ReturnType<typeof submitAttachmentCreation>> | null = null
        const result = files.length
          ? (attachmentReceipt = await submitAttachmentCreation({ key: draftKey!, ownerId: ownerId!,
              deviceId: device.device_id, request, files: files.map((entry) => {
                if (!entry.file) throw Object.assign(new Error('The original attachment is no longer available'), { code: 'creation_attachments_original_missing' })
                return { id: entry.id, file: entry.file }
              }), ports: creationAttachmentPorts(device.device_id, phone, ownerId!) })).result
          : await (phone ? createPhoneSession : createSession)(device.device_id, request)
        if (attachmentReceipt) request = attachmentReceipt.request
        // That machine's last-used set changed: the next new session there starts from it.
        void sessionCreateOptions.refresh(device.device_id)
        if (phone) {
          if (!result.session?.supported || result.session.conversationId !== result.conversationId) throw new Error(tFlow('errors.taskRecordIncomplete'))
          if (!files.length) forgetPhoneSessionCreate(ownerId!, device.device_id, request)
          if (page.active) setPhoneAttempt(null)
        }
        // A different page may now own the visible draft. Keep this admitted receipt and its original Files
        // until that page explicitly resumes the same creation, rather than making its restored files a new task.
        if (attachmentReceipt && !page.active) return
        submittedDraft?.accepted(originalText, files)
        if (page.active) onCreated(result.session ?? toSessionSummary(result, selection.harness!, new Date().toISOString()), request.initialMessageId ? { id: request.initialMessageId, text, sentAt } : undefined, result)
        if (attachmentReceipt) completeAttachmentCreation(draftKey!, attachmentReceipt.request)
      } catch (err) {
        const code = err instanceof SessionpageRpcError ? err.code : err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null
        // Host errors may include private paths. Log only a locally declared code;
        // preserve the original error for the existing retry and user-error contract.
        createLog.warn(creationFailureDiagnostic(code), 'create session failed')
        if (phone && ownerId && submittedPhoneRequest && code === 'phone_create_rejected') {
          // The host explicitly proved it rejected before any durable provision was admitted.
          forgetPhoneSessionCreate(ownerId, device.device_id, submittedPhoneRequest)
          if (page.active) setPhoneAttempt(null)
        }
        if (!page.active) return
        setPendingText(null)
        // 签咕咕额度被拒:那台机器报的是原因码(#7103),按原因说(与新建框咕咕那一组同一份文案)。
        const gugu = guguReasonInText(code)
        const attachmentError = files.length || attachmentAttempt
        const attachmentCopy = code === 'creation_attachments_pending' ? 'attachmentPending'
          : code === 'creation_attachments_unconfirmed' || code === 'attachment_creation_unverified' ? 'attachmentUnconfirmed'
            : code === 'creation_attachments_account_changed' ? 'attachmentAccountChanged'
              : code === 'creation_attachments_original_missing' ? 'attachmentOriginalMissing' : null
        setCreateError(attachmentError ? attachmentCopy ? tFlow(attachmentCopy) : messageForUser(err) : phone ? describe(err) : code === 'harness_install_failed'
          ? t('agentWatch.create.agentInstallFailed')
          : code === 'harness_runtime_missing'
            ? t('agentWatch.create.agentRuntimeMissing')
            : gugu
              ? guguReasonText(gugu, translateSessionMessage)
              : t(`agentWatch.create.failure.${remoteFailureKind(code)}`))
        // 把那句话还回去。assistant-ui 发送时已经清空了输入框,这一步不做就等于吞掉用户输入。
        await submittedDraft?.restore(phoneAttempt?.prompt ?? originalText, files)
        if (!submittedDraft && !runtime.thread.composer.getState().text) runtime.thread.composer.setText(phoneAttempt?.prompt ?? originalText)
      }
    },
  })

  const skillEditor = useRef<PromptEditorRef | null>(null)
  const skillDraft = creationSkillInput(skill => skillEditor.current?.insertMention(skill))

  // @@@effect-flow(lifecycle) - acquire this editor's account-bound draft and settle its hydration/cleanup barrier.
  useEffect(() => {
    if (!draftKey) return
    const binding = bindCreationDraft(runtime.thread.composer, draftKey)
    void binding.ready.catch((error) => { if (page.active) setCreateError(describe(error)) })
    draft.current = binding
    return () => {
      binding.dispose()
      if (draft.current === binding) draft.current = null
    }
  }, [draftKey, runtime.thread.composer, page])

  useEffect(() => {
    if (!otherGroupAttempt && phoneAttempt && pendingText === null && !runtime.thread.composer.getState().text) runtime.thread.composer.setText(phoneAttempt.prompt)
  }, [otherGroupAttempt, phoneAttempt, pendingText, runtime.thread.composer])

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
      <div className="gg-aw-action-error-detail">{createError}</div>
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
  const pendingAttempt = attachmentAttempt ?? phoneAttempt
  const pendingCreationNotice = otherGroupAttempt ? (
    <div className="gg-aw-create-blocker" role="status">{tFlow('groupCreationPendingElsewhere')}</div>
  ) : pendingAttempt && !creating ? (
    <div className="gg-aw-create-blocker" role="status" data-testid="agent-watch-create-pending">
      <div>{tFlow('pendingCreation')}</div>
      <details>
        <summary className="min-h-[var(--control-h-touch)] cursor-pointer py-3">{tFlow('originalTask')}</summary>
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{pendingAttempt.prompt}</div>
      </details>
    </div>
  ) : null
  const optionsNotice = online && (!options || optionsFailure) ? (
    <div className={optionsFailure ? 'gg-aw-action-error' : 'gg-aw-create-blocker gg-aw-create-birth-group'} role={optionsFailure ? 'alert' : 'status'} data-testid={optionsFailure ? 'agent-watch-create-options-error' : 'agent-watch-create-options-loading'}>
      <span>{optionsFailure ? t('agentWatch.create.optionsFailed') : t('agentWatch.create.loadingOptions')}</span>
      {optionsFailure ? <span className="gg-aw-action-error-detail">{describe(optionsFailure)}</span> : null}
      <Button variant="ghost" size="sm" onClick={reloadOptions} data-testid="agent-watch-create-options-retry">{t('agentWatch.timeline.reload')}</Button>
    </div>
  ) : null

  // 派到哪个群里:与上面同一种说明口气。
  const taskGroupNotice = !taskGroup && phoneAttempt?.chatId ? (
    <div className="gg-aw-create-blocker gg-aw-create-birth-group" data-testid="agent-watch-create-task-group">
      <span>{t('agentWatch.create.taskGroup', { name: tFlow('previousGroup') })}</span>
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
  const subtitle = !targetAvailable ? tFlow('noMachine') : connection !== 'online' ? (
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

  const actions = cloudAsleep && (wakeIssue || wakeDropped) ? (
    <IconButton size="md" aria-label={tc('connection.retry')} title={tc('connection.retry')} data-testid="agent-watch-cloud-computer-retry" onClick={retryWake}>
      <RefreshCw />
    </IconButton>
  ) : undefined
  const controls = <div className="gg-aw-thread-extras">
    {errorNotice}
    {optionsNotice}
    {online && harness && modelsReading.state === 'value'
      ? <RefreshFailed reading={modelsReading} /> : null}
    {blockerNotice}
    {pendingCreationNotice}
    {lastUsedNotice}
    {taskGroupNotice}
    {target(creating || (pendingAttempt !== null && !otherGroupAttempt), {
      options, selection, models, modelsState, skills: skillDraft.skills, onSkills: skillDraft.update,
      onOpenModels: refreshModelList,
      onChange: (next, modelPicked) => {
        modelTouched.current = next.harness === selection.harness && (modelTouched.current || modelPicked === true)
        setChosen(next.model !== selection.model || next.harness !== selection.harness
          ? { ...next, fastMode: false } : next)
      },
    })}
  </div>
  const form = <AssistantRuntimeProvider runtime={runtime}>
    <div className={inSheet ? 'gg-aw gg-phone-group-agent-form gg-aw-create-host' : 'gg-aw-thread-host gg-aw-create-host'} data-testid="agent-watch-create-thread">
      {inSheet && <>{subtitle && !optionsNotice && <div className="gg-phone-group-agent-status">{subtitle}{actions}</div>}{controls}{overlay}</>}
      <ComposerExtrasProvider attachmentPlacement="input" editorApiRef={skillEditor}
        placeholder={t('agentWatch.create.placeholder')} extras={null} above={inSheet ? undefined : controls}>
        {inSheet
          ? <ThreadComposer autoFocus={false} submitOnEnter={false} sendDisabled={!canSubmit} />
          : <Thread components={{ Welcome }} autoFocus={false} submitOnEnter={false} sendDisabled={!canSubmit} />}
      </ComposerExtrasProvider>
    </div>
  </AssistantRuntimeProvider>

  return inSheet ? form : (
    <AgentWatchScreen title={t('agentWatch.create.title')} subtitle={subtitle} actions={actions}
      onBack={onBack} testId="agent-watch-create-page" bodyFill>
      {form}
    </AgentWatchScreen>
  )
}
