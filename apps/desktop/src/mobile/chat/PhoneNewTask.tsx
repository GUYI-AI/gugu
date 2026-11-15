import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { remoteFailureKind, type SessionpageSessionCreateModels, type SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import type { ComposerAttachAction } from '@/components/chat/ComposerAttachButton'
import { useToast } from '@/components/toastContext'
import { IconButton } from '@/components/ui/IconButton'
import { X, Zap } from '@/lib/icons'
import { rendererLogger } from '@/lib/log'
import { useDevicesStore } from '@/store/devicesContext'
import { useAuth } from '@/store/auth'
import { CreateTarget } from '../agent-watch/CreateTarget'
import { SelectedCreationSkills } from '../agent-watch/CreateSkills'
import { useCreationSkillDraft } from '../agent-watch/create-skill-draft'
import { preserveComposerFocus, preservePanelComposerFocus } from '../composer/composer-focus'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { useMachineLabel } from '../agent-watch/useMachineLabel'
import { UI_EVENTS } from '@/lib/uiEvents'
import { ProjectFolderCard } from '@renderer/features/projects/components/main-panel/project-folder-card'
import type { ProjectFoldersState, ShownFolder } from '@renderer/features/projects/components/main-panel/project-folders'
import { TaskInGroupError, createTaskInGroup } from '../agent-watch/createTaskInGroup'
import { createModelNeedsSignIn, harnessUsable, initialSelection, reconcileModel, selectHarness, type CreateSelection } from '../agent-watch/create-session-form'
import { SessionpageRpcError, fetchCreateModels, fetchCreateOptions } from '../agent-watch/sessionpage-rpc'
import { taskFoldersOfChat } from './phoneTaskFolders'
import { usePhoneFolderAttach } from './usePhoneFolderAttach'
import { projectRpcOn } from '../partners/projectRpc'
import './phone-new-task.css'

const log = rendererLogger('phone-new-task')
const START = 'gugu:phone-new-task'
export function startPhoneNewTask(chatId: string) { window.dispatchEvent(new CustomEvent(START, { detail: { chatId } })) }

/** off = 发消息;on = 新任务的框(folder 还没点 = 卡浮着等你点;picking = 卡浮着)。 */
type Stage = { kind: 'off' } | { kind: 'on'; folder: ShownFolder | null; picking: boolean }

/**
 * 手机在项目群里派「新任务」(spec mobile-session-view「新任务照电脑」,OpenDCAI/gugu#446):
 * 回形针菜单「新任务」→ 框上方显示工作、智能体、文件夹和技能,这个项目的文件夹卡(电脑上那一张,
 * ProjectFolderCard)浮在群上 → 点一张文件夹,标签旁写明它在哪台机器上(spec:新建任务的地方写明在哪台机器上运行;点它重新挑)→
 * 发出去 = 那台机器那个文件夹里开工,卡落进群,agent 在群里回(同普通群)。
 * 打字不收卡(spec projects「项目首页」);收卡只有点一张文件夹,或标签上的 × 连新任务一起收。
 */
export function usePhoneNewTask({ chatId, enabled, clear }: {
  chatId: string | null | undefined
  /** 手机上、群的主输入框。 */
  enabled: boolean
  /** 发出去之后清空输入框。 */
  clear: () => void
}): {
  action: ComposerAttachAction | null
  active: boolean
  /** 文件夹卡正浮着。 */
  picking: boolean
  placeholder: string | undefined
  /** 浮在输入框上面的文件夹卡。 */
  overlay: ReactNode
  /** 框上沿那一枚任务标签。 */
  band: ReactNode
  inputHeader: ReactNode
  send: (text: string) => Promise<void>
} {
  const { t } = useTranslation('messaging')
  const { t: tControls } = useTranslation('mobileCreateControls')
  const ownerId = useAuth().user?.id ?? null
  const { toast } = useToast()
  const { devices, refresh } = useDevicesStore()
  const { label: machineLabel, isHome } = useMachineLabel()
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  const accountProject = useMemo(
    () => (enabled && chatId ? taskFoldersOfChat(accountList.find((one) => one.chatId === chatId), devices, { label: machineLabel, isHome }) : null),
    [enabled, chatId, accountList, devices, machineLabel, isHome],
  )
  const attach = usePhoneFolderAttach(accountProject, devices, refresh)
  const project = useMemo(() => accountProject ? {
    ...accountProject,
    memberIds: [...new Set([...accountProject.memberIds, ...attach.added.map((item) => item.folder.projectId)])],
    folders: [...new Map([...accountProject.folders, ...attach.added.map((item) => item.folder)].map((folder) => [folder.workspaceId, folder])).values()],
    homeOf: (id: string) => attach.added.find((item) => item.folder.projectId === id)?.home ?? accountProject.homeOf(id),
  } : null, [accountProject, attach.added])
  const [stage, setStage] = useState<Stage>({ kind: 'off' })
  const [options, setOptions] = useState<{ deviceId: string; value: SessionpageSessionCreateOptions | null; failed: boolean } | null>(null)
  const [harness, setHarness] = useState<string | null>(null)
  const [chosenOptions, setChosenOptions] = useState<CreateSelection | null>(null)
  const [modelTouched, setModelTouched] = useState(false)
  const [modelRead, setModelRead] = useState<{ deviceId: string; harness: string; models: SessionpageSessionCreateModels | null; failed: boolean } | null>(null)
  const [sending, setSending] = useState(false)
  const [optionsRead, setOptionsRead] = useState(0)
  useEffect(() => { setStage({ kind: 'off' }) }, [chatId])
  useEffect(() => {
    if (!enabled || !project) return
    const start = (event: Event) => { if ((event as CustomEvent<{ chatId: string }>).detail?.chatId === chatId) setStage({ kind: 'on', folder: null, picking: true }) }
    window.addEventListener(START, start)
    return () => window.removeEventListener(START, start)
  }, [enabled, project, chatId])

  const chosen = stage.kind === 'on' ? stage.folder : null
  const home = chosen ? project?.homeOf(chosen.projectId) : undefined
  const deviceId = home?.deviceId ?? null
  const online = home?.machine.online ?? false
  // 点中一张文件夹:读那台机器上能用的 agent(同手机新建会话页那一份),默认沿用上次的。
  useEffect(() => {
    if (!deviceId || !online) { setOptions(null); return }
    let live = true
    setOptions({ deviceId, value: null, failed: false })
    setChosenOptions(null)
    setModelTouched(false)
    fetchCreateOptions(deviceId).then(
      (value) => {
        if (!live) return
        setOptions({ deviceId, value, failed: false })
        setHarness(initialSelection(value).harness)
      },
      (error: unknown) => {
        log.warn({ error: String(error), deviceId }, 'read the agents on that machine failed')
        if (live) setOptions({ deviceId, value: null, failed: true })
      },
    )
    return () => { live = false }
  }, [deviceId, online, optionsRead])

  const usable = options?.value?.harnesses.filter(harnessUsable) ?? []
  const picked = usable.find((option) => option.id === harness) ?? null
  const selectedHarness = picked?.id ?? null
  const skillDraft = useCreationSkillDraft(ownerId, deviceId ?? '', chatId ?? null, selectedHarness)
  const selectedModel = chosenOptions?.harness === selectedHarness ? chosenOptions.model : null
  // 同创建页读宿主现有目录；不把「能运行 Codex」当作「已登录自有订阅」。
  useEffect(() => {
    if (!deviceId || !online || !selectedHarness || !options?.value) { setModelRead(null); return }
    let live = true
    const initial = selectHarness(initialSelection(options.value), selectedHarness, options.value)
    setModelRead({ deviceId, harness: selectedHarness, models: null, failed: false })
    fetchCreateModels(deviceId, selectedHarness, null, selectedModel ?? initial.model).then(
      (models) => { if (live) setModelRead({ deviceId, harness: selectedHarness, models, failed: false }) },
      (error: unknown) => {
        log.warn({ error: String(error), deviceId, harness: selectedHarness }, 'read the models on that machine failed')
        if (live) setModelRead({ deviceId, harness: selectedHarness, models: null, failed: true })
      },
    )
    return () => { live = false }
  }, [deviceId, online, selectedHarness, selectedModel, options])
  const read = modelRead?.deviceId === deviceId && modelRead.harness === selectedHarness ? modelRead : null
  const selection = options?.value && selectedHarness
    ? reconcileModel(chosenOptions?.harness === selectedHarness ? chosenOptions : selectHarness(initialSelection(options.value), selectedHarness, options.value), read?.models ?? null, modelTouched, options.value.lastUsed)
    : null
  const machine = home?.machine.label ?? ''
  const blocked = !chosen ? t('composer.phoneTask.pickFolder')
    : !online ? t('composer.phoneTask.offline', { machine })
    : options?.failed ? t('composer.phoneTask.optionsFailed', { machine })
      : options?.value && usable.length === 0 ? t('composer.phoneTask.noAgent', { machine })
        : read?.failed ? t('composer.phoneTask.optionsFailed', { machine })
          : picked && !read?.models ? t('agentWatch.create.modelLoading', { ns: 'main' })
            : selection && createModelNeedsSignIn(selection, read?.models ?? null) ? t('agentWatch.create.modelHarnessState.auth-required', { ns: 'main' }) : null

  const folderState: ProjectFoldersState | null = project ? {
    folders: project.folders,
    loadError: false,
    unanswered: [],
    chosen,
    fresh: attach.fresh,
    choose: (workspaceId) => {
      const folder = project.folders.find((candidate) => candidate.workspaceId === workspaceId)
      if (folder) { setOptionsRead((value) => value + 1); setStage({ kind: 'on', folder, picking: false }) }
    },
    reload: () => undefined,
    // 挂文件夹由同一张卡的机器菜单进入 RemoteFolderPicker。
    attach: async (id, path) => {
      const device = devices.find((row) => row.device_id === project.homeOf(id)?.deviceId)
      if (!device) return { ok: false, error: { type: 'rpc-failed', message: 'project machine not found' } }
      const result = await projectRpcOn(device).projects.attachProjectFolder(id, path)
      if (!result.success) return { ok: false, error: result.error }
      await refresh()
      return { ok: true, folder: result.data }
    },
    detach: async (folder) => {
      const device = devices.find((row) => row.device_id === project.homeOf(folder.projectId)?.deviceId)
      if (!device) throw new Error('project machine not found')
      const result = await projectRpcOn(device).projects.detachProjectFolder(folder.projectId, folder.workspaceId)
      if (!result.success) throw new Error(result.error.message)
      if (result.success) { attach.remove(folder.workspaceId); await refresh() }
      return result.success
    },
  } : null

  const overlay = <>{attach.picker}{stage.kind === 'on' && stage.picking && project && folderState ? (
    <div className="gg-phone-task-card" data-testid="phone-task-folder-card"
      onPointerDownCapture={preservePanelComposerFocus} onMouseDownCapture={preservePanelComposerFocus}>
      <ProjectFolderCard
        projectId={project.rowId}
        projectName={project.name}
        folders={folderState}
        memberIds={project.memberIds}
        machines={[...new Set(project.memberIds.map((id) => project.homeOf(id)?.deviceId ?? null))]}
        machineOf={(deviceId) => project.memberIds.map((id) => project.homeOf(id)).find((home) => home?.deviceId === deviceId)?.machine ?? { label: '', online: false, kind: 'computer' }}
        attachMachines={attach.attachMachines}
        onAttach={attach.onAttach}
        onDropFolder={() => undefined}
        floating
        touch
      />
    </div>
  ) : null}</>

  const agentName = picked?.name ?? ''
  const runDevice = devices.find(device => device.device_id === deviceId)
  const creationMachine = runDevice && home && chosen
    ? { device: runDevice, localProjectId: home.localProjectId, path: chosen.path, available: online } : undefined
  const band = stage.kind === 'on' ? <div data-testid="phone-task-tag"><div className="gg-phone-task-controls">
    <CreateTarget projects={[]} project={null} onProject={() => undefined}
      machines={creationMachine ? [creationMachine] : []} machine={creationMachine}
      onMachine={() => undefined} machineLabel={machineLabel} busy={sending}
      projectTask={{ onFolder: () => setStage({ kind: 'on', folder: chosen, picking: true }) }}
      configuration={{ options: options?.value ?? null,
        selection: selection ?? { harness: null, model: null, permissionMode: null, effort: null },
        onChange: (next, modelPicked) => {
          if (next.harness !== harness) setModelTouched(false)
          else if (modelPicked) setModelTouched(true)
          setHarness(next.harness); setChosenOptions(next)
        },
        models: read?.models ?? null, modelsState: read?.failed ? 'failed' : read?.models ? 'ready' : 'loading',
        skills: skillDraft.skills, onSkills: skillDraft.update }} />
    <IconButton size="sm" aria-label={t('composer.phoneTask.cancel')}
      onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus}
      onClick={() => setStage({ kind: 'off' })}><X size={14} /></IconButton>
  </div>{blocked && !stage.picking && <p className="gg-phone-task-blocker" data-testid="phone-task-blocker">{blocked}</p>}</div> : null

  const send = async (text: string) => {
    const typed = text.trim()
    const prompt = skillDraft.skills.length
      ? `${tControls('useSkills', { names: skillDraft.skills.map(skill => skill.name).join(', ') })}\n\n${typed}` : typed
    if (stage.kind !== 'on' || !chatId || !typed || sending) return
    if (blocked || !home || !chosen || !picked || !selection || !read?.models) { toast(blocked ?? t('composer.phoneTask.loading', { machine }), 'error'); return }
    setSending(true)
    try {
      await createTaskInGroup({
        deviceId: home.deviceId, projectId: home.localProjectId, cwd: chosen.path, chatId, prompt, harness: picked.id,
        model: selection.model ?? undefined,
        permissionMode: selection.permissionMode ?? undefined, effort: selection.effort ?? undefined,
      })
      clear()
      skillDraft.update([])
      setStage({ kind: 'off' })
    } catch (error) {
      log.warn({ error: String(error), chatId, deviceId: home.deviceId }, 'dispatch a task from the phone failed')
      if (error instanceof TaskInGroupError) {
        toast(t(`composer.phoneTask.failed.${error.code}`, { machine }), 'error')
        if (error.code !== 'host_outdated') { clear(); setStage({ kind: 'off' }) }
      } else {
        const code = error instanceof SessionpageRpcError ? error.code : null
        toast(t(`agentWatch.create.failure.${remoteFailureKind(code)}`, { ns: 'main' }), 'error')
      }
    } finally {
      setSending(false)
    }
  }

  return {
    // 项目群:浮起文件夹卡;别的群:同桌面输入框「新任务」那一个事件(MainLayout 在手机上进会话页选机器,任务卡落回这个群)。
    action: enabled && chatId && stage.kind === 'off'
      ? { id: 'phone-new-task', label: t('composer.phoneTask.action'), icon: <Zap size={16} />, onSelect: project
        ? () => setStage({ kind: 'on', folder: null, picking: true })
        : () => window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } })) }
      : null,
    active: stage.kind !== 'off',
    picking: stage.kind === 'on' && stage.picking && !!project && !!folderState,
    placeholder: stage.kind === 'on' && agentName ? t('composer.phoneTask.placeholder', { agent: agentName }) : undefined,
    overlay,
    band,
    inputHeader: stage.kind === 'on' ? <SelectedCreationSkills skills={skillDraft.skills} onChange={skillDraft.update} /> : null,
    send,
  }
}
