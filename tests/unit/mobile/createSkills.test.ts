import { describe, expect, it, vi } from 'vitest'
import { creationSkillsHostMethodMissing, creationSkillsHostTooOld, filterCreationSkills, loadCreationSkills } from '../../../apps/desktop/src/mobile/agent-watch/create-skills'

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
  it('preserves the native error code and message instead of returning an empty catalog', async () => {
    const error = { code: 'skills_unavailable', message: 'EACCES: native skill metadata is unreadable' }
    await expect(loadCreationSkills({ sessionCreateSkills: async () => ({ ok: false, error }) }, 'codex', 'project'))
      .rejects.toMatchObject({ name: 'CreationSkillsReadError', ...error })
  })
  it('propagates the original transport rejection with its code', async () => {
    const error = Object.assign(new Error('host disconnected'), { code: 'unreachable' })
    await expect(loadCreationSkills({ sessionCreateSkills: async () => { throw error } }, 'codex', null)).rejects.toBe(error)
  })

  it('uses actual peer/client versions before calling a missing method an outdated host', () => {
    const missing = new Error("No handler registered for 'sessionTimeline.sessionCreateSkills'")
    expect(creationSkillsHostTooOld(missing, '0.3.5-beta.43597758170.1', '0.3.6-beta.43892205063.1')).toBe(true)
    expect(creationSkillsHostTooOld(missing, '0.3.8', '0.3.6')).toBe(false)
    expect(creationSkillsHostTooOld(missing, '0.3.6-beta.old', '0.3.6-beta.new')).toBe(false)
    expect(creationSkillsHostTooOld(missing, '0.3.6', '0.3.6')).toBe(false)
    expect(creationSkillsHostTooOld(missing, 'unknown-build', '0.3.6')).toBe(false)
    expect(creationSkillsHostTooOld(missing, undefined, '0.3.6')).toBe(false)
    expect(creationSkillsHostTooOld(missing, '0.3.5')).toBe(false)
    expect(creationSkillsHostTooOld(Object.assign(new Error('denied'), { code: 'forbidden' }), '0.3.5', '0.3.6')).toBe(false)
  })

  it('distinguishes a missing host route from permission, offline and scanning failures', () => {
    expect(creationSkillsHostMethodMissing(new Error("No handler registered for 'sessionTimeline.sessionCreateSkills'"))).toBe(true)
    expect(creationSkillsHostMethodMissing(Object.assign(new Error('unknown route'), { code: 'unknown_method' }))).toBe(true)
    expect(creationSkillsHostMethodMissing(Object.assign(new Error('denied'), { code: 'forbidden' }))).toBe(false)
    expect(creationSkillsHostMethodMissing(Object.assign(new Error('EACCES: SKILL.md'), { code: 'skills_unavailable' }))).toBe(false)
    expect(creationSkillsHostMethodMissing(Object.assign(new Error('offline'), { code: 'unreachable' }))).toBe(false)
    expect(creationSkillsHostMethodMissing(new Error("No handler registered for 'another.route'"))).toBe(false)
    for (const code of ['skills_unavailable', 'remote_call_refused', 'unreachable', 'EACCES']) {
      expect(creationSkillsHostMethodMissing(Object.assign(new Error("No handler registered for 'sessionTimeline.sessionCreateSkills'"), { code }))).toBe(false)
    }
    expect(creationSkillsHostMethodMissing(new Error("Bad metadata: No handler registered for 'sessionTimeline.sessionCreateSkills'"))).toBe(false)
  })

})
