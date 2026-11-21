import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { i18n } from '@/i18n/runtime'
import '@/i18n/registerMainCatalog'
import { NoticeHost } from '@/components/NoticeHost'
import { dismissNotice } from '@/lib/notices'
import { enqueueImport, importJobs } from '@/components/settings/data-import/import-queue'
import { withCodexTaskImport } from '@/components/settings/data-import/environment-import-providers'
import { importFailureDescription } from '@/components/settings/data-import/import-failure-copy'
import type { ImportProvider } from '@/components/settings/data-import/import-providers'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import '@/styles/tokens.css'

const api = vi.hoisted(() => ({ scanCodexTasks: vi.fn(), importCodexTasks: vi.fn(), cancelCodexTaskImport: vi.fn(), codexTaskImportProgress: vi.fn() }))
vi.mock('@renderer/lib/ipc', async load => ({ ...await load<typeof import('@renderer/lib/ipc')>(), rpcOn: () => ({ sessionImport: api }) }))
vi.mock('@/lib/sessionCoordinator', () => ({ sessionCoordinator: { getSnapshot: () => ({ user: { id: 'fixture' } }), subscribe: () => () => {} } }))
vi.mock('@/components/settings/data-import/import-replicas', () => ({ importSourceCounts: { refresh: vi.fn() }, importedSourceHistory: { refresh: vi.fn() } }))
vi.mock('@/components/settings/data-import/import-sync-preferences', () => ({ updateImportSettings: vi.fn(async () => {}) }))

const base: ImportProvider = { id: 'codex', label: 'ChatGPT', iconId: 'codex', scan: async () => null,
  importAll: async () => ({ imported: [], existing: 0, failed: 0 }) }
const row = { id: 'one', title: 'Example task', revision: 'r1' }
let harness: ReturnType<typeof createReactHarness>
let language: string
let noticeKey: string | undefined
beforeEach(async () => {
  vi.clearAllMocks()
  language = i18n.language
  api.scanCodexTasks.mockResolvedValue({ status: 'ready', rows: [row], blocked: [] })
  api.codexTaskImportProgress.mockResolvedValue(null)
  harness = createReactHarness()
  await page.viewport(900, 560)
  await harness.render(<NoticeHost />)
})
afterEach(async () => {
  if (noticeKey) dismissNotice(noticeKey)
  noticeKey = undefined
  harness.cleanup()
  await i18n.changeLanguage(language)
})

it.each([
  ['en-US', 'The session changed while it was being copied. Refresh the source before importing again.'],
  ['zh-CN', '会话在复制期间发生变化，请刷新来源后重新导入。'],
])('shows the coded RPC failure in the real settings queue notification (%s)', async (locale, expected) => {
  await i18n.changeLanguage(locale)
  api.importCodexTasks.mockRejectedValue(new Error("Error invoking remote method 'sessionImport.importCodexTasks': Error: codex-import-copy-changed:"))
  const provider = withCodexTaskImport(base)
  await provider.scan(null)
  const before = importJobs.getSnapshot()[0]?.id
  await act(async () => enqueueImport('fixture', { provider, devices: [{ deviceId: null, deviceName: 'This computer', count: 1 }] }, i18n.getFixedT(locale, 'main')))
  await expect.poll(() => importJobs.getSnapshot()[0]?.state).toBe('finished')
  const job = importJobs.getSnapshot()[0]!
  expect(job.id).not.toBe(before)
  noticeKey = `settings-data-import-${job.id}`
  await expect.poll(() => document.querySelector('[data-sonner-toast]')?.textContent).toContain(expected)
  const text = document.querySelector('[data-sonner-toast]')!.textContent!
  expect(text).not.toContain('codex-import-')
  expect(text).not.toContain('Error invoking')
  expect(text).not.toContain('/private/')
  await page.screenshot({ path: `../../../../../../../test-results/codex-import-error-${locale}.png` })
})

it('keeps a failed item reason through the provider result for settings history and notification', async () => {
  await i18n.changeLanguage('en-US')
  api.importCodexTasks.mockResolvedValue({ items: [{ id: 'one', status: 'failed', message: 'codex-import-task-failed:one.jsonl' }] })
  const provider = withCodexTaskImport(base)
  await provider.scan(null)
  const result = await provider.importAll(null, () => {}, new AbortController().signal)
  expect(result.failed).toBe(1)
  expect(result.details).toMatchObject([{ id: 'one', title: 'Example task', status: 'failed', reason: 'codex-import-task-failed:one.jsonl' }])
  expect(importFailureDescription(result.details![0]!.reason)).toBe('The session file one.jsonl could not be imported. Try again.')
})

it('localizes unavailable index errors and refuses to turn unknown diagnostics into UI copy', async () => {
  await i18n.changeLanguage('en-US')
  api.scanCodexTasks.mockResolvedValue({ status: 'unavailable', reason: 'unsupported-index', rows: [], blocked: [] })
  const provider = withCodexTaskImport(base)
  await expect(provider.scan(null)).rejects.toThrow('codex-import-index-unreadable:')
  expect(importFailureDescription(new Error('Error: codex-import-index-unreadable:'))).toContain('local ChatGPT task index')
  expect(importFailureDescription(new Error('EACCES /private/source'))).toBeUndefined()
})
