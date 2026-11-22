import { useEffect, useRef, useState } from 'react'
import { ArrowUpToLine, BookOpen, ChevronLeft, Plus, Trash2, X } from '@/lib/icons'
import { useAuth } from '@/store/auth'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { PaneHeader } from '@/components/ui/Pane'
import { ListRowContent } from '@/components/ui/ListRow'
import { Sheet } from '@/components/ui/Sheet'
import { Switch } from '@/components/ui/Switch'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { SettingsNote } from '@/components/settings/SettingsPrimitives'
import { phoneAgentAvailable } from './nativeAgent'
import { thisPhoneDeviceId } from '../phone-device/phoneDeviceSettings'
import { PhoneSkillFields } from './PhoneSkillFields'
import { PhoneSheetHandle } from '../PhoneSheetHandle'
import { useReplica, useReplicaFetching } from '@/lib/replica'
import { importPhoneTaskSkill, phoneTaskSkills, savePhoneTaskSkills, validatePhoneTaskSkills, type PhoneTaskSkill, type PhoneTaskSkillsSnapshot } from './phoneTaskSkills'
import './phone-task-skills.css'
import { PhoneComposerControl } from '../composer/PhoneComposerControls'
import { useTranslation } from 'react-i18next'
import '@/components/session-watch/create-controls-catalog'

const NO_SKILLS: PhoneTaskSkill[] = []

/** The phone's owner configures this task through the existing trusted native UI bridge. */
export function PhoneTaskSkills({ deviceId, sessionId, online, busy = false, menuBar = false }: { deviceId: string; sessionId: string; online: boolean; busy?: boolean; menuBar?: boolean }) {
  const { t } = useTranslation('mobileCreateControls')
  const ownerId = useAuth().user?.id ?? null
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [ownerId, deviceId, sessionId])
  if (!ownerId || !phoneAgentAvailable() || thisPhoneDeviceId(ownerId) !== deviceId) return null
  return (
    <>
      {menuBar ? <PhoneComposerControl label={t('skills')} icon={<BookOpen />} menuExpanded={open} disabled={!online} onClick={() => setOpen(true)} testId="phone-task-skills-open" />
        : <IconButton size="md" aria-label={t('phoneSkills.configure')} title={online ? t('phoneSkills.configure') : t('phoneSkills.configureOffline')} disabled={!online} onClick={() => setOpen(true)} data-testid="phone-task-skills-open"><BookOpen /></IconButton>}
      {open && <PhoneSkillsManager key={`${ownerId}:${deviceId}:${sessionId}`} deviceId={deviceId} sessionId={sessionId} busy={busy || !online} onClose={() => setOpen(false)} />}
    </>
  )
}

export function PhoneSkillsManager({ deviceId, sessionId, busy, onClose }: { deviceId: string; sessionId: string; busy: boolean; onClose: () => void }) {
  const { t } = useTranslation('mobileCreateControls')
  const reading = useReplica(phoneTaskSkills, [deviceId, sessionId])
  const loaded = reading.state === 'value' ? reading.value : null
  // ③ The draft, on top of the revision it started from: a newer revision read meanwhile keeps it; the host refuses its save
  // if that moved (said, with reload).
  const [edited, setEdited] = useState<{ base: PhoneTaskSkillsSnapshot['revision']; skills: PhoneTaskSkill[] } | null>(null)
  const draft = edited ? edited.skills : loaded ? loaded.skills : NO_SKILLS
  const setDraft = (change: (items: PhoneTaskSkill[]) => PhoneTaskSkill[]) => { if (loaded) setEdited({ base: edited?.base ?? loaded.revision, skills: change(draft) }) }
  const [editId, setEditId] = useState<string | null>(null)
  const loading = reading.state === 'unknown'
  const rereading = useReplicaFetching(phoneTaskSkills, [deviceId, sessionId])
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [actionError, setError] = useState<string | null>(null)
  const error = actionError ?? (reading.state === 'error' ? reading.error.message : reading.state === 'value' && reading.error ? reading.error.message : null)
  const [discard, setDiscard] = useState<'close' | 'reload' | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const dirty = loaded !== null && JSON.stringify(draft) !== JSON.stringify(loaded.skills)
  const disabled = saving || importing || loading || rereading || busy || loaded?.busy === true || loaded?.editable !== true
  const selected = draft.find((skill) => skill.id === editId)
  const reload = () => { setEdited(null); setEditId(null); setDiscard(null); setError(null); void phoneTaskSkills.refresh(deviceId, sessionId) }

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const close = () => { if (!saving && !importing) dirty ? setDiscard('close') : onClose() }
  const update = (next: PhoneTaskSkill) => { setDraft((items) => items.map((item) => item.id === next.id ? next : item)); setError(null); setDiscard(null) }
  const add = () => {
    const skill = { id: crypto.randomUUID(), name: '', description: '', instructions: '', enabled: true }
    setDraft((items) => [...items, skill]); setEditId(skill.id); setError(null); setDiscard(null)
  }
  const save = async () => {
    if (!loaded || disabled || !dirty) return
    try { validatePhoneTaskSkills(draft, loaded.limits) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return }
    setSaving(true); setError(null)
    const entry = phoneTaskSkills.at(deviceId, sessionId)
    try {
      const value = await savePhoneTaskSkills(deviceId, sessionId, edited?.base ?? loaded.revision, draft)
      entry.set(value)
      if (!alive.current) return
      setEdited(null); onClose()
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setSaving(false) }
  }
  const importFile = async (file: File) => {
    if (!loaded || disabled) return
    setImporting(true)
    try {
      const skill = await importPhoneTaskSkill(file, loaded.limits)
      if (!alive.current) return
      validatePhoneTaskSkills([...draft, skill], loaded.limits)
      setDraft((items) => [...items, skill]); setEditId(skill.id); setError(null)
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current) setImporting(false) }
  }

  return (
    <Sheet onClose={close} onEscape={() => { if (selected && !saving) { setEditId(null); return true } return false }} mobileHeight="92dvh" desktopWidth="min(640px, 100%)" desktopHeight="640px" testId="phone-task-skills" ariaLabel={t('phoneSkills.title')} closeOnBackdrop={!saving}>
      <div className="gg-phone-skills">
        <PhoneSheetHandle onDismiss={close} disabled={saving || importing} />
        <PaneHeader mobile title={selected ? selected.name || t('phoneSkills.newSkill') : t('phoneSkills.title')} titleLevel="page" leading={selected ? <IconButton size="md" aria-label={t('phoneSkills.backToList')} disabled={saving} onClick={() => setEditId(null)}><ChevronLeft /></IconButton> : undefined} actions={<>
          {selected && <IconButton size="md" aria-label={t('phoneSkills.delete')} disabled={disabled} onClick={() => { setDraft((items) => items.filter((item) => item.id !== selected.id)); setEditId(null); setError(null) }} data-testid="phone-skill-delete"><Trash2 /></IconButton>}
          <IconButton size="lg" aria-label={t('close')} disabled={saving || importing} onClick={close} data-testid="phone-task-skills-close"><X /></IconButton>
        </>} />
        <div className="gg-phone-skills-body">
          <SettingsNote>{t('phoneSkills.scopeNote')}</SettingsNote>
          {loading ? <SettingsNote role="status">{t('phoneSkills.loading')}</SettingsNote> : loaded ? (
            <>
              {(busy || loaded.busy) && <SettingsNote role="status">{t('phoneSkills.busy')}</SettingsNote>}
              {!loaded.editable && <SettingsNote>{t('phoneSkills.configureOnPhone')}</SettingsNote>}
              {selected ? <PhoneSkillFields skill={selected} limits={loaded.limits} disabled={disabled} onChange={update} /> : (
                <>
                  <div className="gg-phone-skills-toolbar">
                    <Button size="sm" variant="primary" disabled={disabled || draft.length >= loaded.limits.maxSkills} onClick={add} data-testid="phone-skill-add"><Plus className="size-4" />{t('phoneSkills.add')}</Button>
                    <Button size="sm" variant="ghost" disabled={disabled || draft.length >= loaded.limits.maxSkills} onClick={() => fileInput.current?.click()} data-testid="phone-skill-import"><ArrowUpToLine className="size-4" />{importing ? t('phoneSkills.importing') : t('phoneSkills.import')}</Button>
                    <input ref={fileInput} type="file" hidden accept=".md,.markdown,text/markdown,text/plain" aria-label={t('phoneSkills.importFile')} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importFile(file) }} />
                  </div>
                  {draft.length === 0 ? <PaneEmptyState icon={<BookOpen />} caption={t('phoneSkills.empty')} hint={t('phoneSkills.emptyHint')} /> : (
                    <div className="gg-phone-skills-list">
                      {draft.map((skill) => <div className="gg-phone-skill-row" key={skill.id}>
                        <Button variant="ghost" size="option" className="gg-list-row gg-row" data-mobile="" onClick={() => setEditId(skill.id)} data-testid={`phone-skill-edit-${skill.id}`}>
                          <ListRowContent title={skill.name || t('phoneSkills.unnamed')} leading={<BookOpen className="size-5" />} subtitle={skill.description || (skill.enabled ? t('phoneSkills.enabled') : t('phoneSkills.disabled'))} />
                        </Button>
                        <Switch checked={skill.enabled} disabled={disabled} onCheckedChange={(enabled) => update({ ...skill, enabled })} aria-label={t('phoneSkills.enableNamed', { name: skill.name || t('phoneSkills.unnamed') })} />
                      </div>)}
                    </div>
                  )}
                </>
              )}
            </>
          ) : null}
          {error && <SettingsNote role="alert" tone="danger" data-testid="phone-skills-error">{error}</SettingsNote>}
          {(!loading && (!loaded || error || loaded.busy)) && <Button size="sm" variant="ghost" disabled={saving || importing} onClick={() => { if (dirty) setDiscard('reload'); else reload() }}>{dirty ? t('phoneSkills.discardAndReload') : t('phoneSkills.reload')}</Button>}
        </div>
        <div className="gg-phone-skills-footer">
          {discard ? (
            <>
              <SettingsNote>{t('phoneSkills.unsaved')}</SettingsNote>
              <div className="gg-phone-skills-actions"><Button variant="ghost" onClick={() => setDiscard(null)}>{t('phoneSkills.keepEditing')}</Button><Button onClick={() => { if (discard === 'reload') reload(); else onClose() }} data-testid="phone-skills-discard">{discard === 'reload' ? t('phoneSkills.discardReload') : t('phoneSkills.discardBack')}</Button></div>
            </>
          ) : (
            <>
              <SettingsNote>{t('phoneSkills.saveNote')}</SettingsNote>
              <div className="gg-phone-skills-actions"><Button variant="ghost" disabled={saving} onClick={close}>{t('phoneSkills.cancel')}</Button><Button variant="primary" disabled={disabled || !dirty} onClick={() => void save()} data-testid="phone-skills-save">{saving ? t('phoneSkills.saving') : t('phoneSkills.save')}</Button></div>
            </>
          )}
        </div>
      </div>
    </Sheet>
  )
}
