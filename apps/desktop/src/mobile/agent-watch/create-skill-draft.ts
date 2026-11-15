import { useState } from 'react'
import type { CreationSkill } from './create-skills'

// Keep target-specific grants separate while the first sentence follows the account's creation draft.
const skillDrafts = new Map<string, CreationSkill[]>()
export function useCreationSkillDraft(owner: string | null, device: string, scope: string | null, harness: string | null) {
  const key = JSON.stringify([owner, device, scope, harness])
  const [record, setRecord] = useState(() => ({ key, skills: skillDrafts.get(key) ?? [] }))
  const skills = record.key === key ? record.skills : skillDrafts.get(key) ?? []
  const update = (next: CreationSkill[]) => { skillDrafts.set(key, next); setRecord({ key, skills: next }) }
  return { skills, update }
}

