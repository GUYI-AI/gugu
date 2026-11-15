import { describe, expect, it, vi } from 'vitest'
import { filterCreationSkills, loadCreationSkills } from '../../../apps/desktop/src/mobile/agent-watch/create-skills'

type Api = Parameters<typeof loadCreationSkills>[0]
const app = (id: string) => ({ id, name: id, permissions: { capabilities: ['agents:tools'] }, contributes: { skills: 'skills', tabs: [] } })
function source() {
  return {
    list: vi.fn(async () => ({ success: true, data: { extensions: [app('notes'), app('off'), app('private')], disabled: ['off'], appIcons: { notes: 'data:image/png;base64,AA==' } } })),
    revoked: vi.fn(async () => ({ success: true, data: {} as Record<string, string[]> })),
    appPlaces: vi.fn(async ({ extensionId }: { extensionId: string }) => ({ success: true, data: [{ id: 'here:all', enabled: extensionId !== 'private' }] })),
    agentSkills: vi.fn(async () => ({ success: true, data: ['capture'], entries: [{ name: 'capture', description: 'Capture a note' }], problems: [] as string[] })),
  }
}
describe('creation skills use the existing selected-device App catalog', () => {
  it('lists real names/descriptions/icons only from enabled Apps given to new agents here', async () => {
    const api = source()
    const result = await loadCreationSkills(api as unknown as Api, null)
    expect(result).toEqual({ skills: [{ id: 'notes:capture', name: 'capture', description: 'Capture a note', app: 'notes', icon: 'data:image/png;base64,AA==' }], partial: false })
    expect(api.agentSkills).toHaveBeenCalledExactlyOnceWith({ extensionId: 'notes' })
    expect(api.appPlaces).not.toHaveBeenCalledWith({ extensionId: 'off' })
  })
  it('accepts an App given to the selected task group, without changing its grants', async () => {
    const api = source()
    api.appPlaces.mockResolvedValue({ success: true, data: [{ id: 'group', enabled: true }] })
    expect((await loadCreationSkills(api as unknown as Api, 'group')).skills).toHaveLength(2)
    expect((await loadCreationSkills(api as unknown as Api, 'other')).skills).toHaveLength(0)
  })
  it('does not offer skills from an App whose agent-tools permission was withdrawn', async () => {
    const api = source()
    api.revoked.mockResolvedValue({ success: true, data: { notes: ['agents:tools'] } })
    expect((await loadCreationSkills(api as unknown as Api, null)).skills).toEqual([])
    expect(api.agentSkills).not.toHaveBeenCalled()
  })
  it('does not treat an unreadable permission record as permission to offer skills', async () => {
    const api = source()
    api.revoked.mockRejectedValue(new Error('permissions unavailable'))
    await expect(loadCreationSkills(api as unknown as Api, null)).rejects.toThrow('permissions unavailable')
  })
  it('does not disguise a delivery-grant or inventory failure as an empty list', async () => {
    const api = source()
    api.appPlaces.mockRejectedValue(new Error('offline'))
    await expect(loadCreationSkills(api as unknown as Api, null)).rejects.toThrow('offline')
    api.list.mockRejectedValue(new Error('disconnected'))
    await expect(loadCreationSkills(api as unknown as Api, null)).rejects.toThrow('disconnected')
  })
  it('keeps old-host names as actual entries, without inventing a description', async () => {
    const api = source()
    api.agentSkills.mockResolvedValue({ success: true, data: ['old'], entries: undefined, problems: [] } as never)
    expect((await loadCreationSkills(api as unknown as Api, null)).skills[0]).toMatchObject({ name: 'old', description: '' })
  })
  it('reports partial reads but refuses a successful empty result when every skill is unreadable', async () => {
    const api = source()
    api.agentSkills.mockResolvedValue({ success: true, data: ['capture'], entries: [{ name: 'capture', description: 'Capture a note' }], problems: ['bad metadata'] })
    expect((await loadCreationSkills(api as unknown as Api, null)).partial).toBe(true)
    api.agentSkills.mockResolvedValue({ success: true, data: [], entries: [], problems: ['bad metadata'] })
    await expect(loadCreationSkills(api as unknown as Api, null)).rejects.toThrow('unreadable')
  })
  it('searches real skill name, description and App source with case-insensitive text', async () => {
    const skills = (await loadCreationSkills(source() as unknown as Api, null)).skills
    expect(filterCreationSkills(skills, '  CAPTURE ')).toHaveLength(1)
    expect(filterCreationSkills(skills, 'a note')).toHaveLength(1)
    expect(filterCreationSkills(skills, 'notes')).toHaveLength(1)
    expect(filterCreationSkills(skills, 'missing')).toEqual([])
  })
})
