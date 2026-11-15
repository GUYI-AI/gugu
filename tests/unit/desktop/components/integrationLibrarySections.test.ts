import { expect, it } from 'vitest'
import { integrationSections } from '../../../../apps/desktop/src/session/renderer/features/integrations/integration-sections'
import { deviceStatusTone, STATUS_DOT_CLASS } from '../../../../apps/desktop/src/session/renderer/features/settings/components/IntegrationDetailSidebar'

// 11-07 资源库盘点:agent 用不上的 issue 系统单列「仅界面」(不删);没给判定的(老 server)照旧算「可用」。
it('puts integrations agents cannot call into their own group, connected ones stay on top', () => {
  const item = (id: string, agentUse: boolean | undefined, isConfigured = false) => ({ id, agentUse, isConfigured, isConfigurationKnown: true })
  const sections = integrationSections([
    item('enterprise-mail', true), item('jira', false), item('old-server', undefined), item('gitlab', false, true),
  ])
  expect(sections.connected.map((i) => i.id)).toEqual(['gitlab'])
  expect(sections.available.map((i) => i.id)).toEqual(['enterprise-mail', 'old-server'])
  expect(sections.uiOnly.map((i) => i.id)).toEqual(['jira'])
})

// 「可用于以下设备」:这台没连是灰点,❌ 红点(红点留给「存着却用不了」)。
it('draws a neutral dot for a device that never connected', () => {
  expect(deviceStatusTone(false)).toBe('notConnected')
  expect(STATUS_DOT_CLASS[deviceStatusTone(false)]).not.toContain('destructive')
  expect(STATUS_DOT_CLASS[deviceStatusTone(true)]).toContain('success')
})
