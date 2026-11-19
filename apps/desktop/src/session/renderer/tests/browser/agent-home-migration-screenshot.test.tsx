import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { i18n } from '@/i18n'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { AgentHomeMigrationResultList } from '@/components/settings/data-import/AgentHomeMigrationResultList'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

let harness: ReturnType<typeof createReactHarness>
let language: string
let viewport: { width: number; height: number }
beforeEach(async () => {
  language = i18n.language
  viewport = { width: innerWidth, height: innerHeight }
  await i18n.changeLanguage('zh-CN')
  await page.viewport(900, 600)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin'
  Object.assign(harness.container.style, { width: '720px', padding: '24px', fontFamily: 'system-ui, sans-serif', background: 'var(--background)' })
})
afterEach(async () => {
  harness?.cleanup()
  await i18n.changeLanguage(language)
  await page.viewport(viewport.width, viewport.height)
})

it('captures the actual Chinese migration result component with preparing and quota-retained states', async () => {
  const common: AgentHomeScan = { providerId: 'codex', name: 'Codex', userRoot: '/fixture/.codex', sourceReadable: true,
    importedAt: null, needsImport: true, sourceUpdated: false, migration: true, groups: [], issues: [], mcpSecrets: [], projectMcpCount: 0 }
  const homes: AgentHomeScan[] = [
    { ...common, migrationPreparation: { phase: 'history', startedAt: Date.now() - 42_000, attempt: 1 } },
    { ...common, providerId: 'claude', name: 'Claude Code', needsImport: false, upgraded: true,
      importedAt: new Date().toISOString(), historyImport: { imported: 16, skipped: 389, sessionBytes: 956_208_287, limitBytes: 1024 ** 3 },
      upgradeIssues: Array.from({ length: 389 }, (_, index) => ({ path: `projects/fixture/older-${index}.jsonl`, reason: 'historyLimit' as const })) },
  ]
  await harness.render(<AgentHomeMigrationResultList homes={homes} />)
  expect(harness.container.textContent).toContain('正在整理历史')
  expect(harness.container.textContent).toContain('389 条较早会话未迁')
  expect(harness.container.textContent).not.toContain('older-0.jsonl')
  expect(harness.container.textContent).not.toContain('·')
  expect(harness.container.textContent).not.toContain('%')
  await document.fonts.ready
  await page.screenshot({ path: '../../../../../../../test-results/agent-home-migration-zh.png', element: harness.container })
})
