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
  if (code) return ['host_update_required', 'server_outdated', 'unknown_method', 'method_not_found'].includes(code)
  return /^No handler registered for ['"]sessionTimeline\.sessionCreateSkills['"]$/.test(error.message)
}

/** A same-build routing failure or an unknown peer version must not be diagnosed as an old installation. */
export function creationSkillsHostTooOld(error: Error, peerVersion?: string, clientVersion?: string): boolean {
  if (!creationSkillsHostMethodMissing(error)) return false
  const core = (version?: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.+-]+)?$/.exec(version ?? '')
    const parts = match?.slice(1, 4).map(Number)
    return parts?.every(Number.isSafeInteger) ? parts : null
  }
  const peer = core(peerVersion), client = core(clientVersion)
  if (!peer || !client) return false
  // Build labels and prerelease ordering do not prove method availability. Equal release cores remain
  // a missing-method failure; only a strictly older release core can support the update diagnosis.
  const different = peer.findIndex((part, index) => part !== client[index])
  return different >= 0 && peer[different]! < client[different]!
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
