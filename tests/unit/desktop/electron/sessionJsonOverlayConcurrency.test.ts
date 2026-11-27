import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySessionMaterialization } from '../../../../apps/desktop/electron/session-materialization'

// #4038: every Antigravity session merges its MCP entries into one shared `mcp_config.json`.
describe('concurrent JSON overlays on one shared file', () => {
  it('keeps every writer\'s keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-overlay-race-'))
    try {
      const guguHome = join(root, 'gugu')
      const path = join(guguHome, 'agent-homes', 'antigravity', '.gemini', 'config', 'mcp_config.json')
      const names = Array.from({ length: 8 }, (_, index) => `server-${index}`)
      await Promise.all(names.map((name) => applySessionMaterialization({
        cwd: root,
        guguHome,
        materialization: { jsonOverlays: [
          { path, sourcePath: path, conflict: 'gugu-owns', mode: 0o600, patch: { mcpServers: { [name]: { command: name } } } },
        ] },
      })))
      const written = JSON.parse(await readFile(path, 'utf8')) as { mcpServers: Record<string, unknown> }
      expect(Object.keys(written.mcpServers).sort()).toEqual(names)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a writer that failed does not block the next one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-overlay-fail-'))
    try {
      const guguHome = join(root, 'gugu')
      const path = join(guguHome, 'shared.json')
      const overlay = { path, sourcePath: path, mode: 0o600 as const, patch: { a: 1 } }
      const bad = applySessionMaterialization({ cwd: root, guguHome, materialization: { jsonOverlays: [
        { ...overlay, conflict: 'unknown' as never },
      ] } })
      const good = applySessionMaterialization({ cwd: root, guguHome, materialization: { jsonOverlays: [
        { ...overlay, conflict: 'gugu-owns' },
      ] } })
      await expect(bad).rejects.toThrow('Unsupported JSON overlay conflict policy')
      await good
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ a: 1 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
