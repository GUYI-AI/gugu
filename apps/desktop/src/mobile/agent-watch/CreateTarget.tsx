import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionpageSessionCreateModels, SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { Check, ChevronRight, Cloud, Folder, Monitor, Smartphone, Sparkles } from '@/lib/icons'
import { useReplica } from '@/lib/replica'
import { creationSkills } from './create-skills-read'
import { Button } from '@/components/ui/Button'
import { PhoneComposerControl, PhoneComposerControlRow, PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { CreateSkillSearch, CreateSkillsList } from './CreateSkills'
import type { CreationSkill } from './create-skills'
import type { ChatComposerProps, ComposerModelOption } from '@gugu/session-ui/react/components'
import { ModelChoices } from './CreateOptionsPill'
import { phoneModelName } from './phone-model-copy'
import { harnessBlockReason, harnessUsable, selectHarness, selectedModelName, type CreateSelection } from './create-session-form'
import type { CreateMachine, CreateProject } from './create-target'
import './create-controls-catalog'
import './task-flow-catalog'
import { phoneMenuBar } from '../composer/phone-menu-bar'
import { PhoneThinkingOptions } from '../composer/PhoneThinkingOptions'
import { creationThinking } from './creation-thinking'

export type ExistingSessionModel = { options?: Record<string, ComposerModelOption> | null; selected?: string; onPick?: (id: string) => void; onOpen?: () => void; fastModePending?: boolean }
  & Pick<ChatComposerProps, 'effortOptions' | 'selectedEffort' | 'onEffortChange' | 'defaultEffort' | 'fastMode' | 'onFastModeChange'
    | 'permissionModeOptions' | 'selectedPermissionMode' | 'onPermissionModeChange'>
type View = 'device' | 'harness' | 'model' | 'effort' | 'permission' | 'project' | 'skills'
export type CreationConfiguration = {
  options: SessionpageSessionCreateOptions | null; selection: CreateSelection
  onChange: (next: CreateSelection, modelPicked?: boolean) => void
  models: SessionpageSessionCreateModels | null; modelsState: 'idle' | 'loading' | 'ready' | 'failed'
  onOpenModels?: () => void
  skills: readonly CreationSkill[]; onSkills: (skills: CreationSkill[]) => void
}

/** The mobile creation row reads the same device, project and model catalogs as before. */
export function CreateTarget({ projects, project, onProject, machines, machine, onMachine, machineLabel: label, busy, configuration, projectTask, existingSession, controlsExtra, scopeChatId, conversationKey }: {
  projects: readonly CreateProject[]; project: CreateProject | null; onProject: (key: string | null) => void
  machines: readonly CreateMachine[]; machine: CreateMachine | undefined; onMachine: (deviceId: string) => void
  machineLabel: (device: CreateMachine['device']) => string; busy: boolean
  configuration?: CreationConfiguration; scopeChatId?: string | null
  existingSession?: { agentName: string; model?: ExistingSessionModel }
  controlsExtra?: ReactNode
  conversationKey?: string
  /** An in-place project task already owns its project; its folder determines the run device. */
  projectTask?: { onFolder: () => void; open: boolean }
}) {
  const { t } = useTranslation('mobileCreateControls')
  const { t: tm } = useTranslation('main')
  const { t: tf } = useTranslation('mobileTaskFlow')
  const [view, setView] = useState<View | null>(null)
  const [search, setSearch] = useState('')
  const modelButton = useRef<HTMLButtonElement>(null)
  const projectButton = useRef<HTMLButtonElement>(null)
  const skillsButton = useRef<HTMLButtonElement>(null)
  const selectedHarness = configuration?.options?.harnesses.find((h) => h.id === configuration.selection.harness)
  const existingPermissions = existingSession?.model?.onPermissionModeChange
    ? Object.entries(existingSession.model.permissionModeOptions ?? {}) : []
  const modelName = configuration && (selectedModelName(configuration.models, configuration.selection)
    ?? (configuration.modelsState === 'loading' && (!configuration.models || configuration.models.harness !== configuration.selection.harness)
      ? tm('agentWatch.create.modelLoading') : tm('agentWatch.create.modelDefault')))
  const activeModelId = existingSession ? existingSession.model?.selected : configuration?.selection.model
  const activeModel = existingSession?.model?.options?.[activeModelId ?? '']
  const modelLabel = existingSession ? activeModel?.shortName ?? activeModel?.name : modelName
  const phone = !!machine && isPhoneDevice(machine.device)
  const menu = phoneMenuBar(existingSession ? 'agent' : projectTask ? 'projectTask' : 'create', {
    work: !existingSession || !!machine || !!existingSession.model?.options || existingPermissions.length > 0,
    project: !existingSession && !projectTask, folder: !!projectTask,
    skills: !!machine && !phone && (!existingSession || !!configuration?.selection.harness),
  })
  const skillCatalog = useReplica(creationSkills, view === 'skills' && machine && !phone && configuration?.selection.harness
    ? [machine.device.device_id, configuration.selection.harness, machine.localProjectId] : null)
  const skillCount = skillCatalog.state === 'value' ? skillCatalog.value.skills.length : null
  const thinking = existingSession?.model ?? (configuration ? creationThinking(configuration.models, configuration.selection) : null)
  const title = t(view === 'device' || !view ? 'modelDevice' : view === 'harness' ? 'agent' : view)
  const select = (next: CreateSelection, modelPicked?: boolean) => { configuration?.onChange(next, modelPicked); setView('device') }
  const workOpen = view !== null && view !== 'project' && view !== 'skills'
  const panelAnchor = view === 'project' ? projectButton : view === 'skills' ? skillsButton : modelButton
  return <>
    <div className="gg-phone-create-controls" data-testid="agent-watch-create-target"><PhoneComposerControlRow conversationKey={conversationKey ?? scopeChatId ?? undefined}>
      {menu.includes('work') && <PhoneComposerControl label={t('modelDevice')} icon={<DeviceIcon device={machine?.device} />} active={workOpen} disabled={busy}
        menuExpanded={workOpen}
        testId="agent-watch-create-model-device" buttonRef={modelButton} onClick={() => setView('device')} />}
      {menu.includes('folder') && projectTask ? <PhoneComposerControl label={t('folder')} icon={<Folder />} disabled={busy}
          menuExpanded={projectTask.open}
          testId="agent-watch-create-folder" onClick={projectTask.onFolder} />
      : menu.includes('project') && <PhoneComposerControl label={t('project')} icon={<Folder />} active={view === 'project'} disabled={busy}
        menuExpanded={view === 'project'}
        testId="agent-watch-create-project" buttonRef={projectButton} onClick={() => setView('project')} />}
      {menu.includes('skills') && <PhoneComposerControl label={t('skills')} icon={<Sparkles />} active={view === 'skills'} disabled={busy || !machine?.available}
        menuExpanded={view === 'skills'}
        testId="agent-watch-create-skills" buttonRef={skillsButton} onClick={() => { setSearch(''); setView('skills') }} />}
      {controlsExtra}
    </PhoneComposerControlRow></div>
    <PhoneComposerSheet open={view !== null && !(phone && view === 'skills' && !existingSession)} onClose={() => setView(null)} title={title} titleCount={view === 'skills' ? skillCount ?? undefined : undefined}
      onBack={workOpen && view !== 'device' ? () => setView('device') : undefined}
      anchor={panelAnchor} testId="agent-watch-create-controls-sheet"
      footer={view === 'skills' && skillCount !== null && skillCount > 0 ? <CreateSkillSearch search={search} onSearch={setSearch} /> : undefined}>
      {view === 'device' && <>
        {existingSession ? <Summary dimension="machine" title={t('device')} value={machine ? label(machine.device) : tf('noMachine')} readOnly onClick={() => {}} /> : <>
        <div className="gg-phone-composer-section-label">{t('device')}</div>
        {machines.map((row) => <Choice key={row.device.device_id} id={row.device.device_id} dimension="machine" name={label(row.device)}
          icon={<DeviceIcon device={row.device} />} description={row.available ? row.path : tf('noFolderHere')}
          selected={machine?.device.device_id === row.device.device_id} disabled={!!existingSession || !row.available || busy} onClick={() => onMachine(row.device.device_id)} />)}
        {!machines.length && <p className="gg-phone-composer-sheet-status">{tf('noMachine')}</p>}
        </>}
        {(!phone || existingSession) && <Summary dimension="harness" title={t('agent')} value={existingSession?.agentName ?? selectedHarness?.name ?? tf('noMachine')} readOnly={!!existingSession} disabled={!configuration?.options} onClick={() => setView('harness')} />}
        <Summary dimension="model" title={t('model')} value={phoneModelName(activeModelId ?? '', modelLabel || tm('agentWatch.create.modelDefault'), t)}
          disabled={existingSession ? !Object.keys(existingSession.model?.options ?? {}).length : !configuration?.options} onClick={() => {
            setView('model')
            if (existingSession) existingSession.model?.onOpen?.()
            else configuration?.onOpenModels?.()
          }} />
        {existingSession?.model && <PhoneThinkingOptions
          effortOptions={existingSession.model.effortOptions} selectedEffort={existingSession.model.selectedEffort}
          defaultEffort={existingSession.model.defaultEffort} onEffortChange={existingSession.model.onEffortChange}
          fastMode={existingSession.model.fastMode} onFastModeChange={existingSession.model.onFastModeChange} fastModePending={existingSession.model.fastModePending}
          disabled={busy} onOpenEffort={() => setView('effort')} />}
        {!existingSession && configuration && <PhoneThinkingOptions {...creationThinking(configuration.models, configuration.selection)} disabled={busy} onOpenEffort={() => setView('effort')}
          onEffortChange={effort => configuration.onChange({ ...configuration.selection, effort })}
          onFastModeChange={fastMode => configuration.onChange({ ...configuration.selection, fastMode })} />}
        {existingPermissions.length > 0 && <Summary dimension="permission" title={t('permission')}
          value={existingSession?.model?.permissionModeOptions?.[existingSession.model.selectedPermissionMode ?? '']?.name ?? t('permission')}
          disabled={busy} onClick={() => setView('permission')} />}
        {!phone && !!selectedHarness?.permissionModes.length && <Summary dimension="permission" title={t('permission')} value={configuration?.selection.permissionMode ? tm(`agentWatch.create.permission.${configuration.selection.permissionMode}.name`) : tm('agentWatch.create.modelDefault')} onClick={() => setView('permission')} />}
      </>}
      {view === 'project' && <div role="radiogroup">
        <Choice id="" dimension="project" name={tf('noProject')} selected={!project} onClick={() => { onProject(null); setView(null) }} />
        {projects.map((one) => <Choice key={one.chatId} id={one.chatId} dimension="project" name={one.name} icon={<Folder />} selected={project?.chatId === one.chatId}
          onClick={() => { onProject(one.chatId); setView(null) }} />)}
      </div>}
      {!existingSession && view === 'harness' && configuration?.options && <div role="radiogroup">
        {configuration.options.harnesses.map((one) => { const reason = harnessBlockReason(one); return <Choice key={one.id} id={one.id} dimension="harness" name={one.name}
          selected={configuration.selection.harness === one.id} disabled={!harnessUsable(one)} description={reason ? tm(`agentWatch.create.harnessStatus.${reason}`) : null}
          onClick={() => select(selectHarness(configuration.selection, one.id, configuration.options!))} /> })}
      </div>}
      {view === 'model' && configuration && <ModelChoices sessionOptions={existingSession?.model?.options ?? undefined} models={configuration.models} state={configuration.modelsState} selection={existingSession ? { ...configuration.selection, model: existingSession.model?.selected ?? null } : configuration.selection}
        harnessName={phone ? tf('phoneAgent') : selectedHarness?.name ?? configuration.selection.harness ?? ''} platformOnly={phone || selectedHarness?.chatAvailable === true && !selectedHarness.watchable}
        onPick={(model) => { if (existingSession) { if (model !== null) existingSession.model?.onPick?.(model); setView('device') } else select({ ...configuration.selection, model }, true) }} onLeave={() => setView(null)} />}
      {view === 'effort' && thinking && <PhoneThinkingOptions {...thinking} fastMode={undefined} disabled={busy}
        onDefaultEffort={!existingSession && configuration ? () => select({ ...configuration.selection, effort: null }) : undefined}
        onEffortChange={effort => {
          if (existingSession) existingSession.model?.onEffortChange?.(effort)
          else if (configuration) configuration.onChange({ ...configuration.selection, effort })
          setView('device')
        }} />}
      {view === 'permission' && existingPermissions.length > 0 ? <div role="radiogroup" aria-label={t('permission')}>
        {existingPermissions.map(([id, option]) => <Choice key={id} id={id} dimension="permission" name={option.name} description={option.description}
          selected={existingSession?.model?.selectedPermissionMode === id} disabled={busy}
          onClick={() => { existingSession?.model?.onPermissionModeChange?.(id); setView('device') }} />)}
      </div> : view === 'permission' && configuration && <div role="radiogroup">
        <Choice id="" dimension="permission" name={tm('agentWatch.create.modelDefault')} selected={!configuration.selection.permissionMode} onClick={() => select({ ...configuration.selection, permissionMode: null })} />
        {selectedHarness?.permissionModes.map((mode) => <Choice key={mode} id={mode} dimension="permission" name={tm(`agentWatch.create.permission.${mode}.name`)}
          selected={configuration.selection.permissionMode === mode} onClick={() => select({ ...configuration.selection, permissionMode: mode })} />)}
      </div>}
      {view === 'skills' && <CreateSkillsList deviceId={machine?.device.device_id ?? null} deviceLabel={machine ? label(machine.device) : undefined} deviceVersion={machine?.device.capabilities.app_version} phone={phone} harness={configuration?.selection.harness ?? null} projectId={machine?.localProjectId ?? null} search={search}
        selected={configuration?.skills ?? []} onChange={(skills) => { configuration?.onSkills(skills); setView(null) }} />}
    </PhoneComposerSheet>
  </>
}

function DeviceIcon({ device }: { device: CreateMachine['device'] | undefined }) {
  if (device && isPhoneDevice(device)) return <Smartphone />
  return device?.cloud_computer ? <Cloud /> : <Monitor />
}

function Choice({ id, dimension, name, description, icon, selected, disabled, onClick }: {
  id: string; dimension: string; name: string; description?: string | null; icon?: ReactNode
  selected?: boolean; disabled?: boolean; onClick: () => void
}) {
  return <Button variant="ghost" className="gg-phone-composer-choice" role="radio" aria-checked={!!selected} disabled={disabled}
    data-testid="agent-watch-create-target-choice" data-dimension={dimension} data-option-id={id} data-selected={selected || undefined} onClick={onClick}>
    {icon}<span className="gg-phone-composer-choice-body"><span className="gg-phone-composer-choice-name">{name}</span>
      {description && <span className="gg-phone-composer-choice-description">{description}</span>}</span>{selected && <Check />}
  </Button>
}
function Summary({ dimension, title, value, disabled, readOnly, onClick }: { dimension: string; title: string; value: string; disabled?: boolean; readOnly?: boolean; onClick: () => void }) {
  if (readOnly) return <div className="gg-phone-composer-choice gg-phone-existing-readonly" data-testid="agent-watch-create-readonly" data-dimension={dimension}>
    <span>{title}</span><span className="gg-phone-composer-summary-value">{value}</span>
  </div>
  return <Button variant="ghost" className="gg-phone-composer-choice" disabled={disabled || readOnly} data-testid="agent-watch-create-options-drill" data-dimension={dimension} onClick={onClick}>
    <span>{title}</span><span className="gg-phone-composer-choice-description gg-phone-composer-summary-value">{value}</span>{!readOnly && <ChevronRight />}
  </Button>
}
