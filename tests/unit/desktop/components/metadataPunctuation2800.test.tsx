// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { deviceSystem } from '../../../../apps/desktop/src/lib/deviceRowModel'
import { FileAttachmentCard } from '../../../../apps/desktop/src/components/chat/FileAttachmentCard'
import { device, createNode, createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerMessagingCatalog'

let ui: ReturnType<typeof createReactHarness> | undefined
afterEach(() => { ui?.cleanup(); setLocalePreference('zh-CN') })
describe('metadata punctuation follows the interface language', () => {
  for (const [locale, separator] of [['zh-CN', '，'], ['en-US', ', ']] as const) {
    it(`uses the ${locale} separator with Chinese file names and English system names`, async () => {
      setLocalePreference(locale)
      expect(deviceSystem(device('metadata-test', [], { platform: 'darwin', capabilities: { arch: 'arm64', terminals: [], runtimes: [] } }))).toBe(`macOS${separator}arm64`)
      ui = createReactHarness()
      await ui.render(createNode(FileAttachmentCard, { file: { fileName: '报告.pdf', sizeBytes: 2048, mimeType: 'application/pdf' } }))
      expect(ui.container.textContent).toContain('报告.pdf')
      expect(ui.container.textContent).toContain(`2.0 KB${separator}`)
      expect(ui.container.textContent).not.toContain(separator === '，' ? ', ' : '，')
    })
  }
})
