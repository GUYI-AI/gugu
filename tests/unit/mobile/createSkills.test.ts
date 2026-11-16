import { describe, expect, it, vi } from 'vitest'
import { filterCreationSkills, loadCreationSkills } from '../../../apps/desktop/src/mobile/agent-watch/create-skills'

describe('native creation skills', () => {
  it('requests the selected harness and actual project, without an App catalog', async () => {
    const skills = [{ id: '/claude/skills/notes/SKILL.md', name: 'notes', description: 'Capture decisions' }]
    const api = { sessionCreateSkills: vi.fn(async () => ({ ok: true, value: { skills } })) }
    expect((await loadCreationSkills(api, 'claude', 'project')).skills).toEqual(skills)
    expect(api.sessionCreateSkills).toHaveBeenCalledWith({ harness: 'claude', projectId: 'project' })
    expect(filterCreationSkills(skills, ' CAPTURE ')).toEqual(skills)
    expect(filterCreationSkills(skills, 'app')).toEqual([])
  })
  it('keeps actual empty and failed catalogs distinct', async () => {
    expect((await loadCreationSkills({ sessionCreateSkills: async () => ({ ok: true, value: { skills: [] } }) }, 'codex', null)).skills).toEqual([])
    await expect(loadCreationSkills({ sessionCreateSkills: async () => ({ ok: false, error: { message: 'offline' } }) }, 'claude', null)).rejects.toThrow('offline')
  })
})
