import type { ExtensionsApi } from '@renderer/features/extensions/extensions-host'
import { HERE_ALL } from '@/session/shared/extensions/host-actions'
import { givesAgentTools } from '@/session/shared/extensions/app-places'

export type CreationSkill = { id: string; name: string; description: string; app: string; icon?: string }
type SkillSource = Pick<ExtensionsApi, 'list' | 'appPlaces' | 'agentSkills'>

/** Read the selected computer's existing App catalog and its existing delivery grants. */
export async function loadCreationSkills(api: SkillSource, scopeChatId: string | null): Promise<{ skills: CreationSkill[]; partial: boolean }> {
  const inventory = await api.list()
  if (!inventory.success || !inventory.data) throw new Error(String(inventory.error ?? 'App inventory is unavailable'))
  const { extensions, disabled, appIcons } = inventory.data
  let partial = false
  const groups = await Promise.all(extensions.filter((app) => app.contributes.skills && givesAgentTools(app) && !disabled.includes(app.id)).map(async (app) => {
    const places = await api.appPlaces({ extensionId: app.id })
    if (!places.success) throw new Error(places.error)
    if (!places.data.some((place) => place.enabled && (place.id === HERE_ALL || place.id === scopeChatId))) return []
    const result = await api.agentSkills({ extensionId: app.id })
    if (!result.success) throw new Error(result.error)
    partial ||= (result.problems?.length ?? 0) > 0
    // Older computers report real names but not descriptions. Keep that distinction visible via the App source.
    const entries = result.entries ?? result.data.map((name) => ({ name, description: '' }))
    return entries.map(({ name, description }) => ({ id: `${app.id}:${name}`, name, description, app: app.name,
      ...(appIcons[app.id] ? { icon: appIcons[app.id] } : {}) }))
  }))
  const skills = groups.flat().sort((a, b) => a.name.localeCompare(b.name))
  if (partial && !skills.length) throw new Error('The catalog contains unreadable skills')
  return { skills, partial }
}

export function filterCreationSkills(skills: readonly CreationSkill[], search: string): CreationSkill[] {
  const query = search.trim().toLocaleLowerCase()
  return skills.filter((skill) => `${skill.name} ${skill.description} ${skill.app}`.toLocaleLowerCase().includes(query))
}
