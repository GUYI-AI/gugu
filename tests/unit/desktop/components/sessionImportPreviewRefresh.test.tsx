// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * 导入本机会话: the picked session's preview read before, read again when it is picked again — the file may be gone
 * since — failing: said, ❌ the old preview shown as current.
 */
const source = vi.hoisted(() => ({ fail: false, reads: 0 }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/session-import/import-source', async () => {
  const { replica } = await import('../../../../apps/desktop/src/lib/replica')
  return {
    sessionImportPreview: replica({
      name: 'sessionImportPreviewTest',
      scope: 'account',
      read: async () => {
        source.reads += 1
        if (source.fail) throw new Error('transcript gone')
        return { title: 'Fix login', turnCount: 2, head: [{ role: 'user', content: 'please fix login' }], tail: [] }
      },
      fresh: 0,
      keep: 60_000,
    }),
  }
})

const { followRendererSession } = await import('../../../../apps/desktop/src/lib/replica')
const { SessionPreviewPane } = await import('../../../../apps/desktop/src/session/renderer/features/session-import/session-preview-pane')

const session = { engine: 'claude', providerSessionId: 'p', title: 'Fix login', cwd: '/w', filePath: '/w/a.jsonl', updatedAt: 0, sizeBytes: 1 } as never
const pane = (picked: unknown) => <SessionPreviewPane session={picked as never} source={{ deviceId: 'local' } as never} describeError={(error) => `failed: ${(error as Error).message}`} />

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { followRendererSession('SIGNED_IN', 'import-owner'); h = createReactHarness(); source.fail = false; source.reads = 0 })
afterEach(() => h.cleanup())
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const text = () => h.container.textContent ?? ''

it('picked again, a read again that fails says so beside the preview read before', async () => {
  await h.render(pane(session))
  await settle()
  expect(text()).toContain('please fix login')
  await h.render(pane(null))
  source.fail = true
  await h.render(pane(session))
  await settle()
  expect(source.reads).toBe(2)
  expect(text()).toContain('failed: transcript gone')
  expect(text()).toContain('please fix login')
})
