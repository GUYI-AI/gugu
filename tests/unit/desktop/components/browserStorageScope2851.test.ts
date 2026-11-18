// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmClearBrowserStorage } from '@/session/renderer/features/browser/browser-toolbar-actions'
import { enUSProjectMessages, zhCNProjectMessages, type ProjectsTranslate } from '@/session/renderer/localization/messages-projects'
import { BROWSER_ISOLATED_PROFILE_ID, DEFAULT_BROWSER_PROFILE_ID, createBrowserSessionSnapshot } from '@/session/shared/browser'

const io = vi.hoisted(() => ({ showModal: vi.fn(), clearData: vi.fn(async () => ({ success: true })) }))
vi.mock('@renderer/lib/modal/modal-provider', async original => ({ ...await original<object>(), showModal: io.showModal }))
vi.mock('@renderer/lib/ipc', () => ({ rpc: { browser: { clearData: io.clearData } } }))
beforeEach(() => { io.showModal.mockClear(); io.clearData.mockClear() })

describe('clear browser data describes its real profile scope', () => {
  it.each([
    ['en', 'research', 'browser profile “Research”', 'Research'],
    ['zh', 'research', '浏览器配置「科研项目」', '科研项目'],
    ['en', DEFAULT_BROWSER_PROFILE_ID, 'default browser profile', 'unused label'],
    ['zh', DEFAULT_BROWSER_PROFILE_ID, '默认浏览器配置', 'unused label'],
    ['en', BROWSER_ISOLATED_PROFILE_ID, 'this isolated browser profile', 'unused label'],
    ['zh', BROWSER_ISOLATED_PROFILE_ID, '当前独立浏览器配置', 'unused label'],
  ])('%s / %s', (locale, profileId, expectedScope, label) => {
    const messages = locale === 'en' ? enUSProjectMessages : zhCNProjectMessages
    const translate: ProjectsTranslate = (key, values) => {
      let text = messages[key as keyof typeof messages] ?? key
      for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
      return text
    }
    const session = createBrowserSessionSnapshot({ identity: { browserId: 'browser-scope-test', projectId: 'project', workspaceId: 'workspace', sessionId: 'agent' }, profileId })
    confirmClearBrowserStorage(session, null, label, translate)
    expect(io.showModal).toHaveBeenCalledTimes(1)
    const modal = io.showModal.mock.calls[0]![1] as { description: string; onSuccess: () => void }
    expect(modal.description).toContain(expectedScope)
    expect(modal.description).toContain(locale === 'en' ? 'Other profiles are not affected' : '其他配置不受影响')
    expect(modal.description).not.toMatch(/storage boundary|存储边界|·/)
    expect(io.clearData).not.toHaveBeenCalled()
    modal.onSuccess()
    expect(io.clearData).toHaveBeenCalledWith('browser-scope-test', 'storage')
  })
})
