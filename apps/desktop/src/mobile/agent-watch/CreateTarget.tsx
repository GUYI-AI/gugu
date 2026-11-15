import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionpageSessionCreateModels, SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { Check, ChevronLeft, ChevronRight, Cloud, Folder, Monitor, Smartphone, Sparkles } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { PhoneComposerControl, PhoneComposerControlRow, PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { CreateSkillSearch, CreateSkillsList } from './CreateSkills'
import type { CreationSkill } from './create-skills'
import { ModelChoices } from './CreateOptionsPill'
import { harnessBlockReason, harnessUsable, selectHarness, selectedEffortName, selectedModelName, type CreateSelection } from './create-session-form'
import type { CreateMachine, CreateProject } from './create-target'
import './create-controls-catalog'
import './task-flow-catalog'

type View = 'device' | 'harness' | 'model' | 'effort' | 'permission' | 'project' | 'skills'
export type CreationConfiguration = {
  options: SessionpageSessionCreateOptions | null; selection: CreateSelection
  onChange: (next: CreateSelection, modelPicked?: boolean) => void
  models: SessionpageSessionCreateModels | null; modelsState: 'idle' | 'loading' | 'ready' | 'failed'
  skills: readonly CreationSkill[]; onSkills: (skills: CreationSkill[]) => void
}

/** The mobile creation row reads the same device, project and model catalogs as before. */
export function CreateTarget({ projects, project, onProject, machines, machine, onMachine, machineLabel: label, busy, configuration }: {
  projects: readonly CreateProject[]; project: CreateProject | null; onProject: (key: string | null) => void
  machines: readonly CreateMachine[]; machine: CreateMachine | undefined; onMachine: (deviceId: string) => void
  machineLabel: (device: CreateMachine['device']) => string; busy: boolean
  configuration?: CreationConfiguration; scopeChatId?: string | null
}) {
  const { t } = useTranslation('mobileCreateControls')
  const { t: tm } = useTranslation('main')
  const { t: tf } = useTranslation('mobileTaskFlow')
  const [view, setView] = useState<View | null>(null)
  const [search, setSearch] = useState('')
  const [skillCount, setSkillCount] = useState<number | null>(null)
  const modelButton = useRef<HTMLButtonElement>(null)
  const selectedHarness = configuration?.options?.harnesses.find((h) => h.id === configuration.selection.harness)
  const modelName = configuration && (selectedModelName(configuration.models, configuration.selection)
    ?? (configuration.modelsState === 'loading' && (!configuration.models || configuration.models.harness !== configuration.selection.harness)
      ? tm('agentWatch.create.modelLoading') : tm('agentWatch.create.modelDefault')))
  const phone = !!machine && isPhoneDevice(machine.device)
  const title = view === 'project' ? t('project') : view === 'skills' ? skillCount === null ? t('skills') : t('skillsCount', { count: skillCount }) : t(view === 'device' || !view ? 'modelDevice' : view === 'harness' ? 'agent' : view)
  const select = (next: CreateSelection, modelPicked?: boolean) => { configuration?.onChange(next, modelPicked); setView('device') }
  const compact = view !== 'project' && view !== 'skills'
  return <>
    <div className="gg-phone-create-controls" data-testid="agent-watch-create-target"><PhoneComposerControlRow>
      <PhoneComposerControl label={t('modelDevice')} icon={<DeviceIcon device={machine?.device} />} active={!!view && compact} disabled={busy}
        testId="agent-watch-create-model-device" buttonRef={modelButton} onClick={() => setView('device')} />
      <PhoneComposerControl label={t('project')} icon={<Folder />} active={view === 'project'} disabled={busy}
        testId="agent-watch-create-project" onClick={() => setView('project')} />
      {!phone && <PhoneComposerControl label={t('skills')} icon={<Sparkles />} active={view === 'skills'} disabled={busy || !machine?.available}
        testId="agent-watch-create-skills" onClick={() => { setSearch(''); setView('skills') }} />}
    </PhoneComposerControlRow></div>
    <PhoneComposerSheet open={view !== null && !(phone && view === 'skills')} onClose={() => setView(null)} title={title}
      anchor={compact ? modelButton : undefined} testId="agent-watch-create-controls-sheet"
      footer={view === 'skills' ? <CreateSkillSearch search={search} onSearch={setSearch} /> : undefined}>
      {view && compact && view !== 'device' && <Button variant="ghost" className="gg-phone-composer-choice" onClick={() => setView('device')}><ChevronLeft />{t('back')}</Button>}
      {view === 'device' && <>
        <div className="gg-phone-composer-section-label">{t('device')}</div>
        {machines.map((row) => <Choice key={row.device.device_id} id={row.device.device_id} dimension="machine" name={label(row.device)}
          icon={<DeviceIcon device={row.device} />} description={row.available ? row.path : tf('noFolderHere')}
          selected={machine?.device.device_id === row.device.device_id} disabled={!row.available || busy} onClick={() => onMachine(row.device.device_id)} />)}
        {!machines.length && <p className="gg-phone-composer-sheet-status">{tf('noMachine')}</p>}
        {!phone && <Summary dimension="harness" title={t('agent')} value={selectedHarness?.name ?? tf('noMachine')} disabled={!configuration?.options} onClick={() => setView('harness')} />}
        <Summary dimension="model" title={t('model')} value={modelName || tm('agentWatch.create.modelDefault')}
          disabled={!configuration?.options} onClick={() => setView('model')} />
        {!!configuration?.models?.efforts.length && <Summary dimension="effort" title={t('effort')} value={selectedEffortName(configuration.models, configuration.selection) ?? tm('agentWatch.create.modelDefault')} onClick={() => setView('effort')} />}
        {!phone && !!selectedHarness?.permissionModes.length && <Summary dimension="permission" title={t('permission')} value={configuration?.selection.permissionMode ? tm(`agentWatch.create.permission.${configuration.selection.permissionMode}.name`) : tm('agentWatch.create.modelDefault')} onClick={() => setView('permission')} />}
      </>}
      {view === 'project' && <div role="radiogroup">
        <Choice id="" dimension="project" name={tf('noProject')} selected={!project} onClick={() => { onProject(null); setView(null) }} />
        {projects.map((one) => <Choice key={one.chatId} id={one.chatId} dimension="project" name={one.name} icon={<Folder />} selected={project?.chatId === one.chatId}
          onClick={() => { onProject(one.chatId); setView(null) }} />)}
      </div>}
      {view === 'harness' && configuration?.options && <div role="radiogroup">
        {configuration.options.harnesses.map((one) => { const reason = harnessBlockReason(one); return <Choice key={one.id} id={one.id} dimension="harness" name={one.name}
          selected={configuration.selection.harness === one.id} disabled={!harnessUsable(one)} description={reason ? tm(`agentWatch.create.harnessStatus.${reason}`) : null}
          onClick={() => select(selectHarness(configuration.selection, one.id, configuration.options!))} /> })}
      </div>}
      {view === 'model' && configuration && <ModelChoices models={configuration.models} state={configuration.modelsState} selection={configuration.selection}
        harnessName={phone ? tf('phoneAgent') : selectedHarness?.name ?? configuration.selection.harness ?? ''} platformOnly={phone || selectedHarness?.chatAvailable === true && !selectedHarness.watchable}
        onPick={(model) => select({ ...configuration.selection, model }, true)} onLeave={() => setView(null)} />}
      {view === 'effort' && configuration && <div role="radiogroup">
        <Choice id="" dimension="effort" name={tm('agentWatch.create.modelDefault')} selected={!configuration.selection.effort} onClick={() => select({ ...configuration.selection, effort: null })} />
        {configuration.models?.efforts.map((one) => <Choice key={one.id} id={one.id} dimension="effort" name={one.name} description={one.description}
          selected={configuration.selection.effort === one.id} onClick={() => select({ ...configuration.selection, effort: one.id })} />)}
      </div>}
      {view === 'permission' && configuration && <div role="radiogroup">
        <Choice id="" dimension="permission" name={tm('agentWatch.create.modelDefault')} selected={!configuration.selection.permissionMode} onClick={() => select({ ...configuration.selection, permissionMode: null })} />
        {selectedHarness?.permissionModes.map((mode) => <Choice key={mode} id={mode} dimension="permission" name={tm(`agentWatch.create.permission.${mode}.name`)}
          selected={configuration.selection.permissionMode === mode} onClick={() => select({ ...configuration.selection, permissionMode: mode })} />)}
      </div>}
      {view === 'skills' && <CreateSkillsList deviceId={machine?.device.device_id ?? null} phone={phone} harness={configuration?.selection.harness ?? null} projectId={machine?.localProjectId ?? null} search={search}
        selected={configuration?.skills ?? []} onCount={setSkillCount} onChange={(skills) => { configuration?.onSkills(skills); setView(null) }} />}
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
function Summary({ dimension, title, value, disabled, onClick }: { dimension: string; title: string; value: string; disabled?: boolean; onClick: () => void }) {
  return <Button variant="ghost" className="gg-phone-composer-choice" disabled={disabled} data-testid="agent-watch-create-options-drill" data-dimension={dimension} onClick={onClick}>
    <span>{title}</span><span className="gg-phone-composer-choice-description gg-phone-composer-summary-value">{value}</span><ChevronRight />
  </Button>
}
