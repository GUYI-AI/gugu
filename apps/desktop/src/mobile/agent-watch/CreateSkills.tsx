import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Check, Search, Sparkles, X } from '@/lib/icons'
import { rendererLogger } from '@/lib/log'
import { preserveComposerFocus } from '../composer/composer-focus'
import { machineRpc } from './sessionpage-rpc'
import { filterCreationSkills, loadCreationSkills, type CreationSkill } from './create-skills'
import './create-controls-catalog'

const log = rendererLogger('mobile/create-skills')
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

export function CreateSkillsList({ deviceId, phone, scopeChatId, search, selected, onChange, onCount }: {
  deviceId: string | null; phone: boolean; scopeChatId: string | null; search: string
  selected: readonly CreationSkill[]; onChange: (skills: CreationSkill[]) => void
  onCount: (count: number | null) => void
}) {
  const { t } = useTranslation('mobileCreateControls')
  const catalogKey = JSON.stringify([deviceId, scopeChatId])
  const [catalog, setState] = useState<{ key: string; status: 'loading' | 'ready' | 'failed'; skills: CreationSkill[]; partial?: boolean }>({ key: catalogKey, status: 'loading', skills: [] })
  const state: typeof catalog = catalog.key === catalogKey ? catalog : { key: catalogKey, status: 'loading', skills: [] }
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!deviceId || phone) return
    let active = true
    onCount(null)
    setState({ key: catalogKey, status: 'loading', skills: [] })
    void loadCreationSkills(machineRpc(deviceId).extensions, scopeChatId).then((result) => {
      if (active) { setState({ key: catalogKey, status: 'ready', ...result }); onCount(result.skills.length) }
    }).catch((error) => {
      log.warn({ error: String(error) }, 'Could not read creation skills')
      if (active) setState({ key: catalogKey, status: 'failed', skills: [] })
    })
    return () => { active = false }
  }, [deviceId, phone, scopeChatId, catalogKey, retry, onCount])
  if (phone) return null
  if (!deviceId) return <p className="gg-phone-composer-sheet-status">{t('emptySkills')}</p>
  if (state.status === 'loading') return <p role="status" className="gg-phone-composer-sheet-status">{t('loadingSkills')}</p>
  if (state.status === 'failed') return <div className="gg-phone-composer-sheet-status" role="alert">{t('failedSkills')}
    <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>{t('retry')}</Button></div>
  const filtered = filterCreationSkills(state.skills, search)
  return <>
    {state.partial && <p role="status" className="gg-phone-composer-sheet-status">{t('partialSkills')}</p>}
    {!filtered.length && <p className="gg-phone-composer-sheet-status">{t(state.skills.length ? 'noMatches' : 'emptySkills')}</p>}
    {filtered.map((skill) => {
      const checked = selected.some((entry) => entry.id === skill.id)
      return <Button key={skill.id} variant="ghost" className="gg-phone-composer-choice" role="checkbox" aria-checked={checked}
        data-testid="agent-watch-create-skill" data-skill-id={skill.id}
        onClick={() => onChange(checked ? selected.filter((entry) => entry.id !== skill.id) : [...selected, skill])}>
        <span className="gg-phone-skill-icon">{skill.icon ? <img src={skill.icon} alt="" /> : <Sparkles />}</span>
        <span className="gg-phone-composer-choice-body"><span className="gg-phone-composer-choice-name">{skill.name}</span>
          <span className="gg-phone-composer-choice-description">{skill.description || t('fromApp', { app: skill.app })}</span></span>
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
