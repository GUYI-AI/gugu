import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/replica'
import { setLocalePreference } from '@/i18n'
import { AgentHomeRow } from '@renderer/features/settings/subscriptions/AgentHomeRow'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'

const control = vi.hoisted(() => ({ changed: false }))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: async () => ({
  scanAgentHomes: async () => ({ success: true, data: [{ providerId: 'codex', name: 'Codex', sourceReadable: true,
    userRoot: '/private/terminal/.codex', importedAt: '2026-11-19T05:56:48.000Z', sourceUpdated: control.changed,
    needsImport: false, migration: false, groups: [], issues: [], mcpSecrets: [], projectMcpCount: 0 }] }),
}) }))
let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  queryClient.clear()
  await setLocalePreference('zh-CN')
  control.changed = false
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { root.unmount(); host.remove(); queryClient.clear() })
it.each([false, true])('summarizes terminal configuration without a path, seconds or indicator dot (changed: %s)', async changed => {
  control.changed = changed
  root.render(<QueryClientProvider client={queryClient}><AgentHomeRow providerId="codex" machine={null} /></QueryClientProvider>)
  await until('the actual terminal import row is read', () => host.querySelector('[data-testid="agent-home-reimport-codex"]') !== null)
  expect(host.querySelector('.gg-settings-row-title')?.textContent).toBe('终端配置')
  const text = host.querySelector('.gg-settings-row-description')?.textContent ?? ''
  expect(text).toContain('导入')
  expect(text.includes('，终端里后来又改过')).toBe(changed)
  expect(text).not.toContain('/private/')
  expect(text).not.toContain('●')
  expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}/)
  expect(text).not.toContain('不会自动同步')
})
