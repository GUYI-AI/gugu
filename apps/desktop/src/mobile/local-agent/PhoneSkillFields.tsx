import { Field } from '@/components/ui/Field'
import { Switch } from '@/components/ui/Switch'
import { SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { useTranslation } from 'react-i18next'
import '@/components/session-watch/create-controls-catalog'
import { phoneSkillCharacterCount, type PhoneSkillLimits, type PhoneTaskSkill } from './phoneTaskSkills'

export function PhoneSkillFields({ skill, limits, disabled, onChange }: { skill: PhoneTaskSkill; limits: PhoneSkillLimits; disabled: boolean; onChange: (skill: PhoneTaskSkill) => void }) {
  const { t } = useTranslation('mobileCreateControls')
  return (
    <div className="gg-phone-skill-fields" data-testid="phone-skill-fields">
      <Field.Root>
        <Field.Label>{t('phoneSkills.fields.name')}</Field.Label>
        <Field.Input value={skill.name} disabled={disabled} onValueChange={(name) => onChange({ ...skill, name })} data-testid="phone-skill-name" autoComplete="off" />
      </Field.Root>
      <Field.Root>
        <Field.Label>{t('phoneSkills.fields.when')}</Field.Label>
        <Field.Input value={skill.description} disabled={disabled} onValueChange={(description) => onChange({ ...skill, description })} data-testid="phone-skill-description" placeholder={t('phoneSkills.fields.whenPlaceholder')} autoComplete="off" />
      </Field.Root>
      <Field.Root>
        <Field.Label>{t('phoneSkills.fields.instructions')}</Field.Label>
        <Field.Textarea value={skill.instructions} disabled={disabled} rows={10} onValueChange={(instructions) => onChange({ ...skill, instructions })} data-testid="phone-skill-instructions" placeholder={t('phoneSkills.fields.instructionsPlaceholder')} spellCheck={false} />
        <Field.Description>{t('phoneSkills.fields.characters', { used: phoneSkillCharacterCount(skill.instructions), max: limits.maxInstructionChars })}</Field.Description>
      </Field.Root>
      <SettingsRow title={t('phoneSkills.fields.enable')} description={t('phoneSkills.fields.enableHint')} control={<Switch aria-label={t('phoneSkills.fields.enable')} checked={skill.enabled} disabled={disabled} onCheckedChange={(enabled) => onChange({ ...skill, enabled })} />} />
      <SettingsNote>{t('phoneSkills.fields.note')}</SettingsNote>
    </div>
  )
}
