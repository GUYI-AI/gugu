import { afterEach, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSISTANT_GUIDE_BEGIN, ASSISTANT_GUIDE_END, LEGACY_ASSISTANT_GUIDE_BEGIN, LEGACY_ASSISTANT_GUIDE_END, assistantHomeKind, assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { refreshAssistantContext } from '../../../apps/desktop/electron/sessionpage/assistant-instructions'
import { NEUTRAL_ASSISTANT_RULES as rules } from './assistantRules/neutralRules'

afterEach(() => { vi.unstubAllEnvs() })

it('treats a self-hosted Linux server as a computer home; only the cloud computer identity selects the cloud layout', () => {
  expect(assistantHomeKind({ GUGU_SERVER_MODE: '1' })).toBe('computer')
  expect(assistantHomeKind({ GUGU_SERVER_MODE: '1', GUGU_CLOUD_COMPUTER: '1' })).toBe('cloud')
  expect(assistantHomeKind({})).toBe('computer')
})

it('decides every assistant layout in the main process from the home identity, never from the launch mode', () => {
  const main = readFileSync(join(__dirname, '../../../apps/desktop/electron/main.ts'), 'utf8')
  expect(main).not.toMatch(/SERVER_MODE \? 'cloud'/)
  expect(main.match(/assistantHomeKind\(process\.env\)/g)?.length).toBe(4)
})

const ownerText = (begin: string, end: string) => `# my rules\nuse tabs\n\n${begin}\n# 你是谁\n个人助理\n${end}\n\ntrailing note\n`
const refresh = (cwd: string, root: string, engine: 'claude' | 'codex' = 'claude') => refreshAssistantContext(cwd, root, 'computer', root, engine, rules)

it('leaves the personal Claude instructions alone on a desktop: only a server ever wrote there', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-desktop-home-'))
  try {
    const personal = join(root, '.claude', 'CLAUDE.md')
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(personal, ownerText(ASSISTANT_GUIDE_BEGIN, ASSISTANT_GUIDE_END))
    await refresh(join(root, 'assistant'), root)
    expect(await readFile(personal, 'utf8')).toBe(ownerText(ASSISTANT_GUIDE_BEGIN, ASSISTANT_GUIDE_END))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('on a server, removes the guide an older build wrote into the personal Claude instructions once, current or legacy marks', async () => {
  vi.stubEnv('GUGU_SERVER_MODE', '1')
  for (const [begin, end] of [[ASSISTANT_GUIDE_BEGIN, ASSISTANT_GUIDE_END], [LEGACY_ASSISTANT_GUIDE_BEGIN, LEGACY_ASSISTANT_GUIDE_END]]) {
    const root = await mkdtemp(join(tmpdir(), 'assistant-server-reclaim-'))
    try {
      const cwd = join(root, 'assistant')
      const personal = join(root, '.claude', 'CLAUDE.md')
      await mkdir(join(root, '.claude'), { recursive: true })
      await writeFile(personal, ownerText(begin, end))
      await refresh(cwd, root)
      expect(await readFile(personal, 'utf8')).toBe('# my rules\nuse tabs\n\ntrailing note\n')
      expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toContain(ASSISTANT_GUIDE_BEGIN)

      // Recorded once: a section the person puts back later is theirs.
      await writeFile(personal, ownerText(begin, end))
      await refresh(cwd, root)
      expect(await readFile(personal, 'utf8')).toBe(ownerText(begin, end))
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

it('on a server, removes a personal instructions file that held only the guide', async () => {
  vi.stubEnv('GUGU_SERVER_MODE', '1')
  const root = await mkdtemp(join(tmpdir(), 'assistant-server-empty-'))
  try {
    const personal = join(root, '.claude', 'CLAUDE.md')
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(personal, `${ASSISTANT_GUIDE_BEGIN}\n# 你是谁\n${ASSISTANT_GUIDE_END}\n`)
    await refresh(join(root, 'assistant'), root)
    await expect(lstat(personal)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('on a server, moves a Codex assistant’s notes from the cloud-layout memory folder back into its home', async () => {
  vi.stubEnv('GUGU_SERVER_MODE', '1')
  const root = await mkdtemp(join(tmpdir(), 'assistant-server-memory-'))
  try {
    const cwd = join(root, 'assistant')
    const paths = assistantHomePaths(root, cwd, 'computer')
    await mkdir(paths.claudeMemoryDir, { recursive: true })
    await writeFile(join(paths.claudeMemoryDir, 'note.md'), 'remember tea')
    await refresh(cwd, root, 'codex')
    expect(await readFile(join(paths.memoryDir, 'note.md'), 'utf8')).toBe('remember tea')
    await expect(lstat(paths.claudeMemoryDir)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
