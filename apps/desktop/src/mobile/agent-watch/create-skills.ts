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

/** Only this catalog call's exact missing-method signal describes capability, not a failed native scan. */
export function creationSkillsHostMethodMissing(error: Error): boolean {
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null
  if (code === 'forbidden' || code === 'EACCES') return false
  return code === 'host_update_required' || code === 'server_outdated' || code === 'unknown_method' || code === 'method_not_found'
    || /No handler registered for ['"]sessionTimeline\.sessionCreateSkills['"]/.test(error.message)
}

/** A same-build routing failure or an unknown peer version must not be diagnosed as an old installation. */
export function creationSkillsHostTooOld(error: Error, peerVersion?: string, clientVersion?: string): boolean {
  return !!peerVersion && !!clientVersion && peerVersion !== clientVersion && creationSkillsHostMethodMissing(error)
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
