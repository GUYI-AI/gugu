import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applySessionMaterialization } from '../../../../apps/desktop/electron/session-materialization'
import { pruneSessionSkillCopies } from '../../../../apps/desktop/electron/session/main/core/extensions/extension-session-snapshot'

describe('a session\'s copy of a skill', () => {
  let root: string, source: string, guguHome: string, target: string
  const materialize = () => applySessionMaterialization({
    cwd: join(root, 'workspace'),
    guguHome,
    materialization: { directoryCopies: [{ sourcePath: source, path: target }] },
  })
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gugu-session-copies-'))
    source = join(root, 'extension-skill')
    guguHome = join(root, 'gugu-home')
    target = join(guguHome, 'capability-packages', 'codex', 'skills', 'fingerprint', 'extension-skill')
    await mkdir(join(source, 'lib'), { recursive: true })
    await writeFile(join(source, 'SKILL.md'), 'skill')
    await writeFile(join(source, 'lib', 'run.mjs'), 'run')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('is a real folder, with what the skill holds, on any filesystem', async () => {
    await materialize()
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('skill')
    expect(await readFile(join(target, 'lib', 'run.mjs'), 'utf8')).toBe('run')
    expect(await readdir(join(target, '..'))).toEqual(['extension-skill'])
  })

  it('is kept for the next session, whose folder name says it holds the same content', async () => {
    await materialize()
    await writeFile(join(source, 'SKILL.md'), 'changed')
    await materialize()
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('skill')
  })

  it('fails loudly when the skill is gone', async () => {
    await rm(source, { recursive: true })
    await expect(materialize()).rejects.toThrow()
  })

  // This does not catch recursive fs.rm following a junction: only Electron's Node on Windows does that, and this runs on
  // plain Node. Measured on a real upgrade.
  it('goes at gugu\'s start; a link from before copies goes, and what it pointed at stays', async () => {
    await materialize()
    const old = join(guguHome, 'capability-packages', 'claude', 'gugu-product', '1.0.0-old', 'skills')
    await mkdir(old, { recursive: true })
    await symlink(source, join(old, 'extension-skill'), process.platform === 'win32' ? 'junction' : 'dir')
    const prompts = join(guguHome, 'capability-packages', 'claude', 'system-prompts')
    await mkdir(prompts, { recursive: true })
    pruneSessionSkillCopies(guguHome)
    expect(await readdir(join(guguHome, 'capability-packages', 'codex'))).toEqual([])
    expect(await readdir(join(guguHome, 'capability-packages', 'claude'))).toEqual(['system-prompts'])
    expect(await readFile(join(source, 'SKILL.md'), 'utf8')).toBe('skill')
    expect(await readFile(join(source, 'lib', 'run.mjs'), 'utf8')).toBe('run')
  })
})
