import { ensureAgentHomeImported } from '@renderer/features/settings/subscriptions/ensure-agent-home'
import { AgentHomeRepair } from '@renderer/features/settings/subscriptions/AgentHomeRepair'
import { isAgentHomeImportCode } from '@gugu/session-core/workspace-server/agent-config'
import type { FirstPrompt } from './use-timeline-session'
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
  SessionpageSessionCreateOptions,
  SessionpageSessionSummary,
  SessionpageSessionCreateRequest,
  SessionpageSessionCreateResult,
} from '@gugu/session-core/session-record/contract'
import type { PromptEditorRef } from '@gugu/session-ui/react/components'
import { Thread, ThreadComposer } from '@/components/assistant-ui/thread.aui'
import { ComposerExtrasProvider } from '@/components/assistant-ui/composer-extras'
import { Button } from '@/components/ui/Button'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import { useAuth } from '@/store/auth'
import { useDevicesStore } from '@/store/devicesContext'
import { rememberRunMachine, useProjectRunMachine } from '@renderer/features/projects/components/main-panel/project-run-machine'
import { forgetPhoneSessionCreate, readPhoneSessionCreate, rememberPhoneSessionCreate } from '../local-agent/phoneSessionCreate'
import { AgentWatchScreen } from './AgentWatchChrome'
import { LiveGlyph } from './StatusGlyph'
import { creationSkillInput } from './create-skill-draft'
import { useMachineLabel } from './useMachineLabel'
import { visibleMachines } from './machine-list'
import { accountProjects, createMachines, runCandidates } from './create-target'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { CreateTarget, type CreationConfiguration } from './CreateTarget'
import { PhoneHostSetupEntry } from './PhoneHostSetupEntry'
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
import { createAttachmentDraftAdapter } from './create-attachment-adapter'
import { creationThinking } from './creation-thinking'
import { creationAttachmentPorts } from './create-attachment-rpc'
import { creationFailureDiagnostic } from './create-failure-diagnostic'
import { completeAttachmentCreation, readAttachmentCreation, readAttachmentCreationDevice, submitAttachmentCreation } from './create-attachment-submission'
import { PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { usePhoneProjectTaskFolder } from '../chat/usePhoneProjectTaskFolder'
import './task-flow-catalog'
import './agent-watch.css'
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
} from './create-session-form'

const createLog = rendererLogger('mobile/agent-watch')

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
  const [optionCatalog, setOptionCatalog] = useState<{ key: string; value: SessionpageSessionCreateOptions } | null>(null)
  const options = optionCatalog?.key === catalogKey ? optionCatalog.value : null
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [selection, setSelection] = useState<CreateSelection>({ harness: null, model: null, permissionMode: null, effort: null })
  /** 人动过选择没有 —— 动过之后「上次那一套没沿用上」就不再说(那是人自己的改动)。 */
  const [touched, setTouched] = useState(false)
  /** 与桌面创建框同一条：明确点选的自家默认不被自动默认覆盖；换 harness 后重算。 */
  const modelTouched = useRef(false)
  /** 选定 harness 的模型目录；自动默认等这份读数，人明确点选后沿用其选择。 */
  const [modelCatalog, setModelCatalog] = useState<{ key: string; value: SessionpageSessionCreateModels } | null>(null)
  const models = modelCatalog?.key === catalogKey ? modelCatalog.value : null
  const [modelsState, setModelsState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [modelRetry, setModelRetry] = useState(0)
  const modelListRead = useRef<Promise<SessionpageSessionCreateModels> | null>(null)
  /** 正在建的那句话;建成或失败后清空。它同时也是线程里唯一那条(乐观显示的)用户消息。 */
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | { providerId: string; name?: string } | null>(null)
  const [phoneAttempt, setPhoneAttempt] = useState<SessionpageSessionCreateRequest | null>(null)
  const attachmentAttempt = draftKey ? readAttachmentCreation(draftKey) : null
  const attachmentAdapter = useMemo(() => draftKey ? createAttachmentDraftAdapter(draftKey) : undefined, [draftKey])

  // 机器离线时**不发 RPC**(与会话页同一条):发过去只会等到超时,而超时长得像「机器没响应」。
  useEffect(() => {
    setOptionCatalog(null)
    setOptionsError(null)
    if (!online) return
    let cancelled = false
    setTouched(false)
    const readOptions = phone ? fetchPhoneCreateOptions : fetchCreateOptions
    readOptions(device.device_id)
      .then((next) => {
        if (cancelled) return
        const attempt = ownerId && draftKey ? readAttachmentCreation(draftKey)
          ?? (phone ? readPhoneSessionCreate(ownerId, device.device_id) : null) : null
        modelTouched.current = attempt !== null
        setPhoneAttempt(attempt && !('attachments' in attempt) ? attempt : null)
        setOptionCatalog({ key: catalogKey, value: next })
        setSelection(attempt ? submittedCreationSelection(attempt) : initialSelection(next))
      })
      .catch((err) => { if (!cancelled) setOptionsError(describe(err)) })
    return () => { cancelled = true }
  }, [device.device_id, online, reloadKey, phone, ownerId, catalogKey, draftKey])

  // 目录跟着 harness 走；复用这次读数定默认，不另发可用性探针。
  // 展示不由手机选:那台电脑按自己的「终端」开关定。
  const harness = selection.harness
  const model = selection.model
  useEffect(() => {
    if (!online || !options || !harness) { setModelCatalog(null); setModelsState('idle'); return }
    let cancelled = false
    // 推理档跟着模型走(桌面同一条),所以换模型也重读;但同一家同一腿只是换模型时**不清空**清单 ——
    // 清了列表会在人刚点完那一下闪没,而且 reconcile 会把刚选的模型判成「不在目录里」清掉。
    setModelCatalog((prev) => (prev?.key === catalogKey && prev.value.harness === harness ? prev : null))
    setModelsState('loading')
    const readModels = phone ? fetchPhoneCreateModels : fetchCreateModels
    readModels(device.device_id, harness, null, model)
      .then((next) => {
        if (cancelled) return
        setModelCatalog({ key: catalogKey, value: next })
        setModelsState('ready')
        const attempt = ownerId && draftKey ? readAttachmentCreation(draftKey)
          ?? (phone ? readPhoneSessionCreate(ownerId, device.device_id) : null) : null
        setSelection((current) => attempt ? submittedCreationSelection(attempt) : reconcileModel(current, next, modelTouched.current, options?.lastUsed))
      })
      .catch(() => { if (!cancelled) setModelsState('failed') })
    return () => { cancelled = true; modelListRead.current = null }
  }, [device.device_id, online, harness, model, reloadKey, phone, options, catalogKey, ownerId, modelRetry, draftKey])

  const refreshModelList = () => {
    if (!online || !options || !harness || modelsState === 'loading' || modelListRead.current) return
    if (!models || models.harness !== harness) { setModelRetry(value => value + 1); return }
    // The menu only needs the list. Passing the selected model would run its effort probe again.
    const readModels = phone ? fetchPhoneCreateModels : fetchCreateModels
    const request = readModels(device.device_id, harness, null, null)
    modelListRead.current = request
    void request.then(next => {
      if (modelListRead.current !== request) return
      setModelCatalog(current => current?.key === catalogKey && current.value.harness === harness ? {
        key: catalogKey, value: {
          ...current.value, models: next.models, harnessState: next.harnessState,
          harnessReason: next.harnessReason, guguReason: next.guguReason,
        },
      } : current)
      setModelsState('ready')
    }, () => { if (modelListRead.current === request) setModelsState('failed') }).finally(() => {
      if (modelListRead.current === request) modelListRead.current = null
    })
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
    setOptionCatalog(null)
    setOptionsError(null)
    setReloadKey((key) => key + 1)
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
      let providerId = selection.harness!
      try {
        if ((phone || files.length) && !ownerId) throw new Error('请先登录后创建 Agent')
        if (attachmentAttempt && !files.length) throw Object.assign(new Error('Original creation attachments are required'), { code: 'creation_attachments_pending' })
        if (phoneAttempt && phoneAttempt.prompt !== text) throw new Error('上次创建尚未确认，请先发送原来的任务以继续同一次创建')
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
        providerId = request.harness
        // The mobile-native Pi runtime has no managed root. Tasks on linked hosts use their import wire.
        if (!phone || providerId !== 'pi') await ensureAgentHomeImported(providerId, device.device_id)
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
        if (phone) {
          if (!result.session?.supported || result.session.conversationId !== result.conversationId) throw new Error('手机尚未返回完整的任务记录，请继续同一次创建')
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
        setCreateError(isAgentHomeImportCode(code)
          ? { providerId, name: options.harnesses.find((item) => item.id === providerId)?.name }
          : attachmentError ? attachmentCopy ? tFlow(attachmentCopy) : messageForUser(err) : phone ? describe(err) : code === 'harness_install_failed'
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

  // @@@effect-flow - acquire this editor's account-bound draft and settle its hydration/cleanup barrier.
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
      <div className="gg-aw-action-error-detail">{typeof createError === 'string' ? createError
        : <AgentHomeRepair {...createError} machine={device.device_id} onImported={() => {
          setCreateError(null)
          setModelRetry((value) => value + 1)
        }} />}</div>
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
  const optionsNotice = online && (!options || optionsError) ? (
    <div className={optionsError ? 'gg-aw-action-error' : 'gg-aw-create-blocker gg-aw-create-birth-group'} role={optionsError ? 'alert' : 'status'} data-testid={optionsError ? 'agent-watch-create-options-error' : 'agent-watch-create-options-loading'}>
      <span>{optionsError ? t('agentWatch.create.optionsFailed') : t('agentWatch.create.loadingOptions')}</span>
      {optionsError ? <span className="gg-aw-action-error-detail">{optionsError}</span> : null}
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
    {blockerNotice}
    {pendingCreationNotice}
    {lastUsedNotice}
    {taskGroupNotice}
    {target(creating || (pendingAttempt !== null && !otherGroupAttempt), {
      options, selection, models, modelsState, skills: skillDraft.skills, onSkills: skillDraft.update,
      onOpenModels: refreshModelList,
      onChange: (next, modelPicked) => {
        modelTouched.current = next.harness === selection.harness && (modelTouched.current || modelPicked === true)
        setTouched(true)
        setSelection(next.model !== selection.model || next.harness !== selection.harness
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
