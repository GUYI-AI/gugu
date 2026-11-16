export type CreationSkill = { id: string; name: string; description: string }
type SkillSource = { sessionCreateSkills: (input: { harness: string; projectId?: string }) => Promise<{
  ok: boolean; value?: { skills: CreationSkill[] }; error?: { code?: string; message: string }
}> }

export class CreationSkillsReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CreationSkillsReadError'
  }
}

/** Read the selected harness's native skills on its execution computer, never installed Apps. */
export async function loadCreationSkills(api: SkillSource, harness: string, projectId: string | null) {
  const result = await api.sessionCreateSkills({ harness, ...(projectId ? { projectId } : {}) })
  if (!result.ok || !result.value) throw new CreationSkillsReadError(result.error?.code ?? 'skills_unavailable', result.error?.message ?? 'Skill catalog is unavailable')
  return { skills: result.value.skills }
}

export function filterCreationSkills(skills: readonly CreationSkill[], search: string): CreationSkill[] {
  const query = search.trim().toLocaleLowerCase()
  return skills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query))
}
