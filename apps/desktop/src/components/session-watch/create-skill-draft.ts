import type { MentionItem } from '@gugu/session-ui/react/components'
import type { CreationSkill } from './create-skills'

/** A skill stays an inline reference to its real SKILL.md, not an attachment or expanded instruction. */
export function creationSkillMention(skill: CreationSkill): MentionItem {
  return { id: skill.id, label: skill.id, name: skill.name, description: skill.description, kind: 'file' }
}

export function creationSkillInput(insert: (skill: MentionItem) => void) {
  return { skills: [] as CreationSkill[], update: (next: CreationSkill[]) => { for (const skill of next) insert(creationSkillMention(skill)) } }
}
