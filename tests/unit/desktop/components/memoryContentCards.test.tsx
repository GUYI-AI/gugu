// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import type { MemoryEntry } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import type { PhonePageProps } from '../../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const reads = vi.hoisted(() => ({ notes: [] as MemoryEntry[], go: vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/markdown/Markdown', () => ({ Markdown: ({ content }: { content: string }) => content }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => null }))
vi.mock('../../../../apps/desktop/src/store/auth', async (original) => ({ ...await original<object>(), useAuth: () => ({ user: null }) }))
vi.mock('../../../../apps/desktop/src/mobile/assistant/usePhoneRead', () => ({ machineKey: () => 'memory', usePhoneRead: (key: string) => ({ state: 'ok', reload: vi.fn(), data: key?.startsWith('memory-counts') ? { voice: 0, files: 0 } : { notes: reads.notes } }) }))
vi.mock('../../../../apps/desktop/src/mobile/assistant/PhoneMachineView', () => ({ PhoneMachineView: ({ children }: { children: () => ReactNode }) => children(), ReadView: ({ read, children }: { read: { data: unknown }; children: (data: unknown) => ReactNode }) => children(read.data) }))
vi.mock('../../../../apps/desktop/src/mobile/assistant/PhoneHealth', () => ({ PhoneHealth: () => null }))
import { PhoneMemory } from '../../../../apps/desktop/src/mobile/assistant/PhoneMemory'

const machine = { paths: { resourcesDir: '/assistant/files' }, deviceId: 'fixture-device' }
const secret = '仅供 Agent 检索：事实、依据与推测分开记'
const note = (file: string, body: string, kind: MemoryEntry['kind']): MemoryEntry => ({ file, title: file === 'owner-profile.md' ? '关于主人' : '项目记录', description: secret, body, kind, path: `/memory/${file}`, modifiedAt: '2026-10-01T00:00:00Z' })
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); reads.go.mockReset(); reads.notes = [note('owner-profile.md', '# About you\n## Basic facts\n- **姓名：小林**\n- 喜欢简短的说明', 'user'), note('project.md', '# Project\n- 项目正文事实', 'project')] })
afterEach(() => harness.cleanup())

describe('phone memory content cards', () => {
  const render = async (sub?: string) => {
    const common = { assistant: { id: 'assistant', display_name: '咕咕' }, readiness: 'ready', askInChat: vi.fn(), go: reads.go, homeDeviceId: 'device' }
    await renderWithAppProviders(harness, <PhoneMemory {...{ ...common, sub: sub ?? null, machine: { state: 'ready', machine } } as unknown as PhonePageProps} />)
  }
  // The phone's 记忆 cards are the assistant App's page; the phone keeps only the note its 健康 page opens.
  it('keeps the detail body intact', async () => {
    await render('note:owner-profile.md')
    expect(harness.container.querySelector('[data-testid="assistant-memory-body"]')?.textContent).toBe(reads.notes[0].body)
    expect(harness.container.textContent).not.toContain(secret)
  })
})
