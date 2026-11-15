import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readNativeCreationSkills } from '../../../apps/desktop/electron/session/main/core/session-timeline/create-skills'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))) })
async function root() { const dir = await fs.mkdtemp(join(tmpdir(), 'native-skills-')); dirs.push(dir); return dir }
async function skill(dir: string, name: string, description: string) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nReal skill instructions`) }
describe('native skill files', () => {
  it('reads actual nested skills, prefers project definitions, and terminates symlink cycles', async () => {
    const dir = await root(); await skill(join(dir, 'project', 'notes'), 'notes', 'Project instructions'); await skill(join(dir, 'user', 'notes'), 'notes', 'User instructions'); await skill(join(dir, 'user', '.system', 'code'), 'code', 'Review code'); await fs.symlink(join(dir, 'user'), join(dir, 'user', 'loop'))
    const result = await readNativeCreationSkills([join(dir, 'project'), join(dir, 'user')])
    expect(result.map(({ name, description }) => ({ name, description }))).toEqual([{ name: 'code', description: 'Review code' }, { name: 'notes', description: 'Project instructions' }])
  })
  it('reports missing directories as empty and malformed real files as a failure', async () => {
    const dir = await root(); expect(await readNativeCreationSkills([join(dir, 'missing')])).toEqual([])
    await fs.writeFile(join(dir, 'SKILL.md'), 'not skill metadata')
    await expect(readNativeCreationSkills([dir])).rejects.toThrow('Invalid skill metadata')
  })
})
