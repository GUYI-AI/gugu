import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, X } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Sheet } from '@/components/ui/Sheet'
import type { CreateMachine, CreateProject } from './create-target'
import './task-flow-catalog'

type Choice = { id: string; name: string; desc?: string | null; disabled?: boolean }

/**
 * 新建页输入框上方的「项目 · 机器」两行(DESIGN 点击路径 4a):两行都带默认值,点开选,选完就关。
 * 机器只是这一次跑在哪:选了项目,有它文件夹的机器在上;没有文件夹的照列、点不动(手机上还不能就地绑文件夹)。
 */
export function CreateTarget({
  projects,
  project,
  onProject,
  machines,
  machine,
  onMachine,
  machineLabel: label,
  busy,
}: {
  projects: readonly CreateProject[]
  project: CreateProject | null
  onProject: (key: string | null) => void
  machines: readonly CreateMachine[]
  machine: CreateMachine | undefined
  onMachine: (deviceId: string) => void
  /** 机器叫什么(useMachineLabel,与项目页、会话页同一套叫法)。 */
  machineLabel: (device: CreateMachine['device']) => string
  busy: boolean
}) {
  const { t } = useTranslation('main')
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  const [open, setOpen] = useState<'project' | 'machine' | null>(null)
  const noProject = '\u0000none'
  const projectChoices: Choice[] = [{ id: noProject, name: tFlow('noProject') }, ...projects.map((one) => ({ id: one.chatId, name: one.name }))]
  const machineChoices: Choice[] = machines.map((row) => ({
    id: row.device.device_id,
    name: label(row.device),
    desc: row.available ? row.path : tFlow('noFolderHere'),
    disabled: !row.available,
  }))
  const title = open === 'machine' ? tFlow('machine') : t('agentWatch.create.project')
  const pick = (id: string) => {
    if (open === 'project') onProject(id === noProject ? null : id)
    else onMachine(id)
    setOpen(null)
  }

  return (
    <>
      <div className="gg-aw-summary-group" data-testid="agent-watch-create-target">
        <Row dimension="project" label={t('agentWatch.create.project')} value={project?.name ?? tFlow('noProject')} disabled={busy} onClick={() => setOpen('project')} />
        <Row dimension="machine" label={tFlow('machine')} value={machine ? label(machine.device) : tFlow('noMachine')} disabled={busy || machines.length === 0} onClick={() => setOpen('machine')} />
      </div>
      <Sheet open={open !== null} onClose={() => setOpen(null)} mobileFitContent testId="agent-watch-create-target-sheet" ariaLabel={title}>
        {open ? <div className="gg-aw gg-aw-sheet">
          <div className="gg-aw-sheet-head">
            <IconButton size="lg" className="gg-aw-sheet-nav" aria-label={t('agentWatch.options.close')} onClick={() => setOpen(null)}>
              <X />
            </IconButton>
            <div className="gg-aw-sheet-title">{t('agentWatch.options.pick', { name: title })}</div>
            <div className="gg-aw-sheet-side" />
          </div>
          <div className="gg-aw-choice-group" role="radiogroup" data-dimension={open}>
            {(open === 'project' ? projectChoices : machineChoices).map((choice) => {
              const selected = choice.id === (open === 'project' ? project?.chatId ?? noProject : machine?.device.device_id)
              return (
                <Button
                  key={choice.id}
                  variant="ghost"
                  size="option"
                  className="gg-aw-choice"
                  role="radio"
                  aria-checked={selected}
                  disabled={choice.disabled}
                  data-testid="agent-watch-create-target-choice"
                  data-dimension={open}
                  data-option-id={choice.id}
                  onClick={() => pick(choice.id)}
                >
                  <span className="gg-aw-choice-radio" data-on={selected ? 'true' : undefined}>
                    {selected ? <Check /> : null}
                  </span>
                  <span className="gg-aw-choice-body">
                    <span className="gg-aw-choice-label">{choice.name}</span>
                    {choice.desc ? <span className="gg-aw-choice-desc">{choice.desc}</span> : null}
                  </span>
                </Button>
              )
            })}
          </div>
        </div> : null}
      </Sheet>
    </>
  )
}

function Row({ dimension, label, value, disabled, onClick }: { dimension: string; label: string; value: string; disabled: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="option"
      className="gg-aw-summary"
      data-testid="agent-watch-create-target-row"
      data-dimension={dimension}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="gg-aw-summary-label">{label}</span>
      <span className="gg-aw-summary-value">{value}</span>
      <ChevronRight />
    </Button>
  )
}
