import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { AssistantFileError, assistantFileFailure } from '@gugu/core/shared/assistantFileError'
import { refreshAssistantContext } from '../../../apps/desktop/electron/sessionpage/assistant-instructions'
import { preserveDamagedAssistantSettings, writeAssistantFile } from '../../../apps/desktop/electron/sessionpage/assistant-files'
import { startupFailureForUser } from '../../../apps/desktop/electron/session/main/core/sessions/spawn-failure'
import { failureText, safeFailureLine } from '../../../apps/desktop/src/session/renderer/features/sessions/gugu-reason'

const io = vi.hoisted(() => ({ events: [] as string[], failSync: false, failBackup: false,
  beforeBackup: null as null | ((path: string) => Promise<void>), afterBackup: null as null | ((path: string) => Promise<void>) }))
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({ agentHookService: { emitAgentEvent: vi.fn() } }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      return {
        writeFile: async (...input: Parameters<typeof file.writeFile>) => { io.events.push('write'); return file.writeFile(...input) },
        sync: async () => { io.events.push('sync'); if (io.failSync) throw new Error('injected fsync failure'); await file.sync() },
        close: async () => { io.events.push('close'); await file.close() },
      }
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]).includes('.damaged-')) {
        if (io.failBackup) throw new Error('injected backup failure')
        await io.beforeBackup?.(String(args[0]))
        const moved = await fs.rename(...args)
        await io.afterBackup?.(String(args[0]))
        return moved
      } else io.events.push('rename')
      return fs.rename(...args)
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  io.events.length = 0; io.failSync = false; io.failBackup = false; io.beforeBackup = null; io.afterBackup = null
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function settingsFile(content: string | Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-damaged-settings-'))
  roots.push(root)
  const cwd = join(root, 'assistant')
  const paths = assistantHomePaths(root, cwd, 'computer')
  await mkdir(join(cwd, '.claude'), { recursive: true })
  await writeFile(paths.settings, content)
  await writeFile(paths.instructions, 'Keep the owner instructions.\n')
  return { root, cwd, paths, refresh: () => refreshAssistantContext(cwd, root, 'computer', root),
    backups: async () => (await readdir(join(cwd, '.claude'))).filter(name => name.startsWith('settings.json.damaged-')) }
}

it.each([
  ['NUL bytes', Buffer.alloc(8192)], ['empty file', ''], ['whitespace', ' \t\r\n'], ['NUL and whitespace', '\0 \0\n'],
])('preserves %s byte-for-byte and resumes the real assistant context preparation', async (_name, content) => {
  const fixture = await settingsFile(content)
  await Promise.all(Array.from({ length: 3 }, () => fixture.refresh()))
  const backups = await fixture.backups()
  expect(backups).toHaveLength(1)
  expect(await readFile(join(fixture.cwd, '.claude', backups[0]!))).toEqual(Buffer.from(content))
  const settings = JSON.parse(await readFile(fixture.paths.settings, 'utf8'))
  expect(settings.permissions.deny).toContain('CronCreate')
  expect(settings.claudeMdExcludes).toContain(join(fixture.root, 'CLAUDE.md'))
  expect(await readFile(fixture.paths.instructions, 'utf8')).toContain('Keep the owner instructions.')
  const fresh = await readFile(fixture.paths.settings)
  await fixture.refresh()
  expect(await readFile(fixture.paths.settings)).toEqual(fresh)
  expect(await fixture.backups()).toEqual(backups)
})

it.each(['null', '[]', '42', 'true', '"owner-setting-sentinel"', '{broken', '{"secret":"owner-setting-sentinel"}\0'])('rejects %s without overwriting or backing up human settings', async content => {
  const fixture = await settingsFile(content)
  const error = await fixture.refresh().catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(AssistantFileError)
  expect((error as Error).message).toContain(fixture.paths.settings)
  expect((error as Error).message).toContain('correct it to a JSON object')
  expect((error as Error).message).not.toContain('owner-setting-sentinel')
  expect(await readFile(fixture.paths.settings, 'utf8')).toBe(content)
  expect(await fixture.backups()).toEqual([])
  expect(await readFile(fixture.paths.instructions, 'utf8')).toBe('Keep the owner instructions.\n')
})

it('stops before replacing damaged settings when the backup cannot be retained', async () => {
  const fixture = await settingsFile('\0\0')
  io.failBackup = true
  await expect(fixture.refresh()).rejects.toMatchObject({ path: fixture.paths.settings, operation: 'backup' })
  expect(await readFile(fixture.paths.settings, 'utf8')).toBe('\0\0')
  expect(await fixture.backups()).toEqual([])
})

it('flushes and closes every host-written assistant file before publishing it', async () => {
  const fixture = await settingsFile('{}')
  await fixture.refresh()
  expect(io.events).toEqual(Array.from({ length: 3 }, () => ['write', 'sync', 'close', 'rename']).flat())
})

it('preserves the current file and removes temporary bytes when fsync fails', async () => {
  const fixture = await settingsFile('{"model":"keep"}')
  io.failSync = true
  await expect(writeAssistantFile(fixture.paths.settings, '{}')).rejects.toMatchObject({ operation: 'write' })
  expect(await readFile(fixture.paths.settings, 'utf8')).toBe('{"model":"keep"}')
  expect(io.events).toEqual(['write', 'sync', 'close'])
  expect(await readdir(join(fixture.cwd, '.claude'))).toEqual(['settings.json'])
})

it('retains the damage backup if regeneration fails and recovers on the next attempt', async () => {
  const fixture = await settingsFile('\0')
  io.failSync = true
  await expect(fixture.refresh()).rejects.toBeInstanceOf(AssistantFileError)
  const backups = await fixture.backups()
  expect(backups).toHaveLength(1)
  expect(await readFile(join(fixture.cwd, '.claude', backups[0]!), 'utf8')).toBe('\0')
  io.failSync = false
  await fixture.refresh()
  expect(JSON.parse(await readFile(fixture.paths.settings, 'utf8'))).toHaveProperty('permissions')
  expect(await fixture.backups()).toEqual(backups)
})

it('passes the actionable file failure through the existing startup and localized display outlet', async () => {
  const fixture = await settingsFile('[]')
  const error = await fixture.refresh().catch((cause: unknown) => cause)
  const userError = startupFailureForUser(new Error('capability preparation failed', { cause: error }))
  const ipc = `Error invoking remote method 'sessions.hydrateSession': ${String(userError)}`
  expect(safeFailureLine(ipc)).toContain(fixture.paths.settings)
  const translate = vi.fn((_key: string, values?: Record<string, string>) => `Repair ${values?.path}`)
  expect(failureText(ipc, translate)).toBe(`Repair ${fixture.paths.settings}`)
  expect(translate).toHaveBeenCalledWith('taskError.assistantFileInvalid', { path: fixture.paths.settings })
  expect(safeFailureLine('Provider error at /Users/person/private/settings.json with sk-private-token')).not.toContain('/Users/person')
  expect(assistantFileFailure('Assistant file "relative/settings.json" could not be read. Check the file and its permissions, then retry.')).toBeNull()
})

it('keeps a normal file written by another process after the damage was read and before the backup was taken', async () => {
  const fixture = await settingsFile('\0\0')
  io.beforeBackup = async path => { await writeFile(path, '{"model":"newer-owner-choice"}') }
  await fixture.refresh()
  expect(await fixture.backups()).toEqual([])
  const settings = JSON.parse(await readFile(fixture.paths.settings, 'utf8'))
  expect(settings.model).toBe('newer-owner-choice')
  expect(settings.permissions.deny).toContain('CronCreate')
})

it('does not overwrite or back up other broken JSON written after the damage was read', async () => {
  const fixture = await settingsFile('\0')
  io.beforeBackup = async path => { await writeFile(path, '{broken-owner-edit') }
  const error = await fixture.refresh().catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(AssistantFileError)
  expect(await readFile(fixture.paths.settings, 'utf8')).toBe('{broken-owner-edit')
  expect(await fixture.backups()).toEqual([])
})

it('keeps the replaced content in the backup when yet another file appears before it can be restored', async () => {
  const fixture = await settingsFile('\0')
  io.beforeBackup = async path => { await writeFile(path, '{"model":"second-writer"}') }
  io.afterBackup = async path => { await writeFile(path, '{"model":"third-writer"}') }
  await fixture.refresh()
  const backups = await fixture.backups()
  expect(backups).toHaveLength(1)
  expect(await readFile(join(fixture.cwd, '.claude', backups[0]!), 'utf8')).toBe('{"model":"second-writer"}')
  expect(JSON.parse(await readFile(fixture.paths.settings, 'utf8')).model).toBe('third-writer')
})

it('does not back up a file that changed before the move', async () => {
  const fixture = await settingsFile('\0')
  expect(await preserveDamagedAssistantSettings(fixture.paths.settings, ' ')).toBe(false)
  expect(await readFile(fixture.paths.settings, 'utf8')).toBe('\0')
  expect(await fixture.backups()).toEqual([])
})
