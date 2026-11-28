import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeLegacyAssistantPanelState } from '../../../../apps/desktop/electron/lib/remove-legacy-assistant-panel-state'

const log = { info: () => {}, warn: () => {} }
let home: string | undefined
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }) })

it('removes what the deleted panel runtime left behind, keeps the overflow index, and is a no-op the second time', async () => {
  home = await mkdtemp(join(tmpdir(), 'panel-migration-'))
  const hash = 'a'.repeat(64)
  await mkdir(join(home, 'assistant-panel-body-failures'), { recursive: true })
  await writeFile(join(home, 'assistant-panel-body-failures', `${hash}.json`), '{}')
  await mkdir(join(home, 'assistant-resource-state'), { recursive: true })
  await writeFile(join(home, 'assistant-resource-state', `resources-${hash}.json`), '{}')
  await writeFile(join(home, 'assistant-resource-state', `index-${hash}.md`), 'index')
  await writeFile(join(home, 'assistant-resource-state', 'resources-notes.json'), 'kept: not a journal name')

  expect(removeLegacyAssistantPanelState(home, log)).toEqual({ removed: 2, failed: 0 })
  expect((await readdir(home)).sort()).toEqual(['assistant-resource-state'])
  expect((await readdir(join(home, 'assistant-resource-state'))).sort()).toEqual([`index-${hash}.md`, 'resources-notes.json'])
  expect(removeLegacyAssistantPanelState(home, log)).toEqual({ removed: 0, failed: 0 })
})

it('does nothing on a home that never had the runtime', async () => {
  home = await mkdtemp(join(tmpdir(), 'panel-migration-'))
  expect(removeLegacyAssistantPanelState(home, log)).toEqual({ removed: 0, failed: 0 })
})
