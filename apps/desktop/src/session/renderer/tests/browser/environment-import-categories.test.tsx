import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { i18n } from '@/i18n'
import { createReactHarness, clickElement } from '../../../../../../../tests/support/testHarness'
import { LocalImportSources } from '@/components/settings/data-import/ImportSourceRows'
import { ImportSyncSettings } from '@/components/settings/data-import/ImportSyncSettings'
import type { ImportJob } from '@/components/settings/data-import/import-queue'
import type { ImportProvider } from '@/components/settings/data-import/import-providers'
import { ENVIRONMENT_IMPORT_CATEGORIES } from '@shared/core/session-import/environment-import'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'
import '@/components/settings/data-import/data-import.css'

const state = vi.hoisted(() => ({
  counts: {} as Record<string, number | 'error'>,
  enqueue: vi.fn(), refresh: vi.fn(), cancel: vi.fn(), cancelAutomatic: vi.fn(),
  owners: { fixture: { automatic: true, sources: ['codex'], categories: ['tasks'] as string[] } },
  update: vi.fn(),
}))
vi.mock('@/lib/replica', async load => ({ ...await load<typeof import('@/lib/replica')>(),
  useReplicas: (_source: unknown, keys: [string, string | null][]) => keys.map(([id]) => state.counts[id] === 'error'
    ? { state: 'error', error: new Error('fixture') }
    : { state: 'value', value: { count: state.counts[id] ?? 0, pending: false } }),
}))
vi.mock('@/components/settings/data-import/import-replicas', () => ({ importSourceCounts: { refresh: state.refresh } }))
vi.mock('@/components/settings/data-import/import-queue', () => ({
  enqueueImport: state.enqueue, cancelImport: state.cancel, cancelAutomaticImports: state.cancelAutomatic,
  isActiveImport: (job: { state: string }) => ['running', 'queued', 'cancelling'].includes(job.state),
}))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({
  settings: { state: 'value', value: { value: { owners: state.owners } } }, refresh: state.refresh,
}) }))
vi.mock('@/components/settings/data-import/import-sync-preferences', () => ({
  importSettingsForOwner: (stored: { owners: typeof state.owners }, id: 'fixture') => stored.owners[id],
  updateImportSettings: async (id: 'fixture', change: (before: typeof state.owners.fixture) => typeof state.owners.fixture) => {
    state.update(id); state.owners[id] = change(state.owners[id])
  },
}))
vi.mock('@/components/settings/data-import/import-sync', () => ({ syncImports: vi.fn() }))

const providers: ImportProvider[] = ENVIRONMENT_IMPORT_CATEGORIES.map((category, index) => ({
  id: category === 'tasks' ? 'codex' : `codex:${category}`, label: 'ChatGPT', sourceLabel: 'ChatGPT', sourceId: 'codex',
  category, iconId: 'codex', scan: async () => ({ count: index + 1, pending: false }),
  importAll: async () => ({ imported: [], existing: 0, failed: 0 }),
}))
let harness: ReturnType<typeof createReactHarness>
let language: string
let viewport: { width: number; height: number }
beforeEach(async () => {
  vi.clearAllMocks()
  providers.forEach((provider, index) => { state.counts[provider.id] = index + 1 })
  state.owners.fixture = { automatic: true, sources: ['codex'], categories: ['tasks'] }
  language = i18n.language; viewport = { width: innerWidth, height: innerHeight }
  await i18n.changeLanguage('zh-CN'); await page.viewport(900, 800)
  harness = createReactHarness(); harness.container.className = 'gugu-skin emlight'
  Object.assign(harness.container.style, { width: '620px', padding: '24px', fontFamily: 'system-ui, sans-serif', background: 'var(--bg)', color: 'var(--fg)' })
})
afterEach(async () => {
  harness?.cleanup(); await i18n.changeLanguage(language); await page.viewport(viewport.width, viewport.height)
})

it('renders all five real category rows and queues only the selected category or all five', async () => {
  await harness.render(<LocalImportSources providers={providers} ownerId="fixture" jobs={[]} />)
  const rows = [...harness.container.querySelectorAll('.gg-import-row')]
  expect(rows.map(row => row.querySelector('.gg-import-row-label')?.textContent)).toEqual([
    '全部（15）', '任务 (1)', '空间（项目） (2)', '记忆 (3)', '技能 (4)', '连接器 (5)',
  ])
  await clickElement(rows[4]!.querySelector('button')!)
  expect(state.enqueue).toHaveBeenCalledTimes(1)
  expect(state.enqueue.mock.calls[0]![1].provider.category).toBe('skills')
  state.enqueue.mockClear()
  await clickElement(rows[0]!.querySelector('button')!)
  expect(state.enqueue.mock.calls.map(call => call[1].provider.category)).toEqual([...ENVIRONMENT_IMPORT_CATEGORIES])
  expect(harness.container.textContent).not.toContain('·')
  await document.fonts.ready
  await page.screenshot({ path: '../../../../../../../test-results/environment-import-categories-zh.png', element: harness.container })
})

it('a failed category never becomes a complete total or blocks another category from importing', async () => {
  state.counts['codex:skills'] = 'error'
  await harness.render(<LocalImportSources providers={providers} ownerId="fixture" jobs={[]} />)
  const rows = [...harness.container.querySelectorAll('.gg-import-row')]
  expect(rows[0]!.querySelector('button')!.disabled).toBe(true)
  expect(rows[0]!.textContent).not.toContain('11')
  await clickElement(rows[4]!.querySelector('button')!)
  expect(state.refresh).toHaveBeenCalledWith('codex:skills', null)
  await clickElement(rows[2]!.querySelector('button')!)
  expect(state.enqueue.mock.calls[0]![1].provider.category).toBe('projects')
})

it('persists selected sync categories and reads the saved range after remount', async () => {
  await harness.render(<ImportSyncSettings ownerId="fixture" />)
  await clickElement([...harness.container.querySelectorAll('button')].find(button => button.textContent === '自定义')!)
  const labels = () => [...document.querySelectorAll('label.gg-import-checkbox')]
  await expect.poll(() => labels().length).toBe(6)
  await clickElement(labels().find(label => label.textContent === '技能')!.querySelector('[role="checkbox"]')!)
  await clickElement([...document.querySelectorAll('button')].find(button => button.textContent === '保存')!)
  await expect.poll(() => state.owners.fixture.categories).toEqual(['tasks', 'skills'])
  expect(state.cancelAutomatic).toHaveBeenCalledWith('fixture', ['tasks', 'skills'])
  harness.cleanup(); harness = createReactHarness()
  await harness.render(<ImportSyncSettings ownerId="fixture" />)
  expect(harness.container.textContent).toContain('已选择 2 个类别')
})

it('renders the actual preparing-history status while a task import is running', async () => {
  const job: ImportJob = { id: 'running', ownerId: 'fixture', provider: providers[0]!,
    devices: [{ deviceId: null, deviceName: 'This computer', count: 1 }], state: 'running', done: 0, total: 1,
    preparation: { phase: 'history', startedAt: Date.now() - 42_000 } };
  await harness.render(<LocalImportSources providers={providers} ownerId="fixture" jobs={[job]} />);
  expect(harness.container.textContent).toContain('正在整理历史');
  expect(harness.container.textContent).toContain('已用 42 秒');
  expect(harness.container.textContent).not.toContain('%');
  await page.screenshot({ path: '../../../../../../../test-results/environment-import-preparing-zh.png', element: harness.container });
});

it('keeps legacy export-file histories distinct from resumable native tasks', async () => {
  const history = { ...providers[0]!, id: 'chatgpt-json', sourceId: undefined, sourceLabel: undefined,
    label: 'ChatGPT 导出文件', historyOnly: true };
  state.counts[history.id] = 2;
  await harness.render(<LocalImportSources providers={[history]} ownerId="fixture" jobs={[]} />);
  await clickElement(harness.container.querySelector('.gg-import-card-trigger')!);
  expect(harness.container.textContent).toContain('只读历史记录');
  expect(harness.container.querySelectorAll('.gg-import-row')).toHaveLength(2);
  expect(harness.container.textContent).not.toContain('任务');
});
