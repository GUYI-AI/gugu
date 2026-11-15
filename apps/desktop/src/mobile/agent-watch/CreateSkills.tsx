import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Check, Search, Sparkles, X } from '@/lib/icons'
import { useReadModel } from '@/lib/readModel'
import { creationSkills } from './create-skills-read'
import { preserveComposerFocus } from '../composer/composer-focus'
import { filterCreationSkills, type CreationSkill } from './create-skills'
import './create-controls-catalog'

export function SelectedCreationSkills({ skills, onChange }: { skills: readonly CreationSkill[]; onChange: (skills: CreationSkill[]) => void }) {
  const { t } = useTranslation('mobileCreateControls')
  return skills.length ? <div className="gg-phone-selected-skills" data-testid="agent-watch-create-skill-tags">
    {skills.map((skill) => <span className="gg-phone-selected-skill" key={skill.id}>
      <span>{skill.name}</span><IconButton size="sm" aria-label={t('removeSkill', { name: skill.name })}
        onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus}
        onClick={() => onChange(skills.filter((entry) => entry.id !== skill.id))}><X /></IconButton>
    </span>)}
  </div> : null
}

export function CreateSkillsList({ deviceId, phone, harness, projectId, search, selected, onChange }: {
  deviceId: string | null; phone: boolean; harness: string | null; projectId: string | null; search: string
  selected: readonly CreationSkill[]; onChange: (skills: CreationSkill[]) => void
}) {
  const { t } = useTranslation('mobileCreateControls')
  const state = useReadModel(creationSkills, deviceId && harness && !phone ? [deviceId, harness, projectId] : null)
  if (phone) return null
  if (!deviceId || !harness || state.state === 'unknown') return <p role="status" className="gg-phone-composer-sheet-status">{t('loadingSkills')}</p>
  const retry = <div className="gg-phone-composer-sheet-status" role="alert">{t('failedSkills')}
    <Button variant="ghost" size="sm" onClick={() => void creationSkills.refresh(deviceId, harness, projectId)}>{t('retry')}</Button></div>
  if (state.state === 'error') return retry
  const filtered = filterCreationSkills(state.value.skills, search)
  return <>
    {state.error && retry}
    {!filtered.length && <p className="gg-phone-composer-sheet-status">{t(state.value.skills.length ? 'noMatches' : 'emptySkills')}</p>}
    {filtered.map((skill) => {
      const checked = selected.some((entry) => entry.id === skill.id)
      return <Button key={skill.id} variant="ghost" className="gg-phone-composer-choice" role="checkbox" aria-checked={checked}
        data-testid="agent-watch-create-skill" data-skill-id={skill.id}
        onClick={() => onChange(checked ? selected.filter((entry) => entry.id !== skill.id) : [...selected, skill])}>
        <span className="gg-phone-skill-icon"><Sparkles /></span>
        <span className="gg-phone-composer-choice-body"><span className="gg-phone-composer-choice-name">{skill.name}</span>
          <span className="gg-phone-composer-choice-description">{skill.description}</span></span>
        {checked && <Check />}
      </Button>
    })}
  </>
}

export function CreateSkillSearch({ search, onSearch }: { search: string; onSearch: (value: string) => void }) {
  const { t } = useTranslation('mobileCreateControls')
  return <label className="gg-phone-composer-search"><Search /><input type="search" value={search}
    aria-label={t('searchSkills')} placeholder={t('searchSkills')} onChange={(event) => onSearch(event.target.value)} /></label>
}
