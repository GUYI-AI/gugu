import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { i18n } from '@/i18n'
import { createReactHarness, clickElement } from '../../../../../../../tests/support/testHarness'
import { LocalImportSources } from '@/components/settings/data-import/ImportSourceRows'
import { ImportSyncSettings } from '@/components/settings/data-import/ImportSyncSettings'
import type { ImportProvider } from '@/components/settings/data-import/import-providers'
import { ENVIRONMENT_IMPORT_CATEGORIES } from '@shared/core/session-import/environment-import'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'
import '@/components/settings/data-import/data-import.css'

const state = vi.hoisted(() => ({
  counts: {} as Record<string, number | 'error' | 'unknown' | 'pending'>,
  enqueue: vi.fn(), refresh: vi.fn(), cancel: vi.fn(), cancelAutomatic: vi.fn(),
  owners: { fixture: { automatic: true, sources: ['codex'], categories: ['tasks'] as string[] } },
  update: vi.fn(),
  listIcons: vi.fn(async () => ({
    codex: { kind: 'svg' as const, variants: [{ minSize: 0, light: '<svg viewBox="0 0 16 16"><path d="M4 8h8" /></svg>' }] },
  })),
}))
vi.mock('@renderer/lib/ipc', async load => ({
  ...await load<typeof import('@renderer/lib/ipc')>(),
  rpc: { agents: { listIcons: state.listIcons } },
}))
vi.mock('@/lib/replica', async load => ({ ...await load<typeof import('@/lib/replica')>(),
  useReplicas: (_source: unknown, keys: [string, string | null][]) => keys.map(([id, deviceId]) => state.counts[id] === 'error'
    ? { state: 'error', error: new Error('fixture'), retry: async () => { state.refresh(id, deviceId) } }
    : state.counts[id] === 'unknown' ? { state: 'unknown' }
    : { state: 'value', value: { count: typeof state.counts[id] === 'number' ? state.counts[id] : 0, pending: state.counts[id] === 'pending' } }),
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

/** Source rows draw agent icons, which read through react-query. */
let queryClient: QueryClient
const withQueries = (node: ReactNode) => <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>

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
  queryClient = new QueryClient()
  providers.forEach((provider, index) => { state.counts[provider.id] = index + 1 })
  state.owners.fixture = { automatic: true, sources: ['codex'], categories: ['tasks'] }
  language = i18n.language; viewport = { width: innerWidth, height: innerHeight }
  await i18n.changeLanguage('zh-CN'); await page.viewport(900, 800)
  harness = createReactHarness(); harness.container.className = 'gugu-skin emlight'
  Object.assign(harness.container.style, { width: '620px', padding: '24px', fontFamily: 'system-ui, sans-serif', background: 'var(--bg)', color: 'var(--fg)' })
})
afterEach(async () => {
  try {
    harness?.cleanup()
  } finally {
    await queryClient.cancelQueries()
    queryClient.clear()
    await i18n.changeLanguage(language)
    await page.viewport(viewport.width, viewport.height)
  }
})

/** The source row's own 「全部导入」. */
const importAll = () => [...harness.container.querySelectorAll<HTMLButtonElement>('.gg-import-source button')].find(button => button.textContent === '全部导入')!

it('opens every source folded, whichever source it is', async () => {
  const history = { ...providers[0]!, id: 'cursor', sourceId: undefined, sourceLabel: undefined, label: 'Cursor', historyOnly: true }
  state.counts[history.id] = 2
  await harness.render(withQueries(<LocalImportSources providers={[...providers, history]} ownerId="fixture" jobs={[]} />))
  const toggles = [...harness.container.querySelectorAll<HTMLButtonElement>('.gg-import-source [aria-expanded]')]
  expect(toggles.map(toggle => toggle.getAttribute('aria-label'))).toEqual(['ChatGPT', 'Cursor'])
  expect(toggles.map(toggle => toggle.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
  await clickElement(toggles[0]!)
  expect(toggles.map(toggle => toggle.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
})

it('renders all five real category rows and queues only the selected category or all five', async () => {
  await harness.render(withQueries(<LocalImportSources providers={providers} ownerId="fixture" jobs={[]} />))
  await clickElement(harness.container.querySelector('.gg-import-source [aria-expanded]')!)
  const rows = [...harness.container.querySelectorAll('.gg-import-row')]
  expect(rows.map(row => row.querySelector('.gg-settings-row-title')?.textContent)).toEqual([
    '任务1', '空间2', '记忆3', '技能4', '连接器5',
  ])
  expect(harness.container.querySelector('.gg-import-source')!.textContent).toContain('15')
  await clickElement(rows[3]!.querySelector('button')!)
  expect(state.enqueue).toHaveBeenCalledTimes(1)
  expect(state.enqueue.mock.calls[0]![1].provider.category).toBe('skills')
  state.enqueue.mockClear()
  await clickElement(importAll())
  expect(state.enqueue.mock.calls.map(call => call[1].provider.category)).toEqual([...ENVIRONMENT_IMPORT_CATEGORIES])
  expect(harness.container.textContent).not.toContain('·')
  await document.fonts.ready
  await page.screenshot({ path: '../../../../../../../test-results/environment-import-categories-zh.png', element: harness.container })
})

it('a failed category never becomes a complete total or blocks another category from importing', async () => {
  state.counts['codex:skills'] = 'error'
  await harness.render(withQueries(<LocalImportSources providers={providers} ownerId="fixture" jobs={[]} />))
  const rows = [...harness.container.querySelectorAll('.gg-import-row')]
  expect(importAll().disabled).toBe(true)
  expect(harness.container.querySelector('.gg-import-source')!.textContent).not.toContain(i18n.t('settings.dataImport.reading', {ns:'main'}))
  expect(harness.container.textContent).toContain('部分来源暂不可读取')
  expect(harness.container.querySelector('.gg-import-source')!.textContent).not.toContain('11')
  await clickElement(rows[3]!.querySelector('button')!)
  expect(state.refresh).toHaveBeenCalledWith('codex:skills', null)
  await clickElement(rows[1]!.querySelector('button')!)
  expect(state.enqueue.mock.calls[0]![1].provider.category).toBe('projects')
})

it('persists selected sync categories and reads the saved range after remount', async () => {
  await harness.render(withQueries(<ImportSyncSettings ownerId="fixture" />))
  await clickElement([...harness.container.querySelectorAll('button')].find(button => button.textContent === '自定义')!)
  const labels = () => [...document.querySelectorAll('label.gg-import-checkbox')]
  await expect.poll(() => labels().length).toBe(6)
  await clickElement(labels().find(label => label.textContent === '技能')!.querySelector('[role="checkbox"]')!)
  await clickElement([...document.querySelectorAll('button')].find(button => button.textContent === '保存')!)
  await expect.poll(() => state.owners.fixture.categories).toEqual(['tasks', 'skills'])
  expect(state.cancelAutomatic).toHaveBeenCalledWith('fixture', ['tasks', 'skills'])
  harness.cleanup(); harness = createReactHarness()
  await harness.render(withQueries(<ImportSyncSettings ownerId="fixture" />))
  expect(harness.container.textContent).toContain('已选择 2 个类别')
})

it('keeps read-only history sources distinct from resumable native tasks', async () => {
  const history = { ...providers[0]!, id: 'cursor', sourceId: undefined, sourceLabel: undefined,
    label: 'Cursor', historyOnly: true };
  state.counts[history.id] = 2;
  await harness.render(withQueries(<LocalImportSources providers={[history]} ownerId="fixture" jobs={[]} />));
  await clickElement(harness.container.querySelector('.gg-import-source [aria-expanded]')!);
  expect(harness.container.textContent).toContain('只读历史记录');
  expect(harness.container.querySelectorAll('.gg-import-row')).toHaveLength(1);
  expect(harness.container.textContent).not.toContain('任务');
});

it.each(['unknown', 'pending'] as const)('continues checking a genuinely %s source', async stateName => {
  state.counts.codex = stateName;
  await harness.render(withQueries(<LocalImportSources providers={providers} ownerId="fixture" jobs={[]} />));
  expect(harness.container.querySelector('.gg-import-source')!.textContent).toContain(i18n.t('settings.dataImport.reading', { ns: 'main' }));
  expect(harness.container.querySelector('.gg-import-row button')!.hasAttribute('disabled')).toBe(true);
});

it('shows a confirmed empty native source without a perpetual checking label', async () => {
  providers.forEach(provider => { state.counts[provider.id] = 0 });
  await harness.render(withQueries(<LocalImportSources providers={providers} ownerId="fixture" jobs={[]} />));
  expect(harness.container.querySelector('.gg-import-source')!.textContent).toContain('0');
  expect(harness.container.textContent).not.toContain(i18n.t('settings.dataImport.reading', { ns: 'main' }));
  expect(harness.container.querySelector('.gg-import-row button')!.hasAttribute('disabled')).toBe(true);
});

