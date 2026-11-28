/**
 * The composer is a plain-text editing surface: a web address or an email in it stays text, and a click on it only places
 * the caret. Links become live once the message is sent, read by the one message dialect.
 *
 * Before: StarterKit's Link extension autolinked both (an unstyled `<a>`), and a plain click on one opened it outside the
 * app with no hint. Judged on the real DOM: a real paste, then a real (Playwright) click on the first letters of the address.
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { ChatComposer, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@/styles/tokens.css'
import '@renderer/index.css'
import { until } from '../../../../../../../tests/support/awaitCondition'

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  root?.unmount()
  root = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

function mount(editor: { current: PromptEditorRef | null }) {
  host = document.createElement('div')
  host.className = 'gugu-skin'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <SessionLocalizationProvider>
      <ChatComposer editorApiRef={editor} onAttachmentsChange={() => {}} onSubmit={() => {}} />
    </SessionLocalizationProvider>,
  )
}

function paste(editable: HTMLElement, text: string) {
  const dt = new DataTransfer()
  dt.setData('text/plain', text)
  editable.focus()
  editable.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
}

describe('composer links stay plain text', () => {
  it.each([
    ['a web address', 'https://example.com/page'],
    ['an email', 'someone@example.com'],
  ])('%s is not turned into a link and a click on it opens nothing', async (_kind, text) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const editor: { current: PromptEditorRef | null } = { current: null }
    mount(editor)
    await until('editor mounted', () => host?.querySelector('[contenteditable="true"]') != null && editor.current != null)
    const editable = host!.querySelector<HTMLElement>('[contenteditable="true"]')!

    paste(editable, text)
    await until('text pasted', () => editor.current!.getText() === text)
    expect(editable.querySelector('a')).toBeNull()

    await userEvent.click(editable.querySelector('p')!, { position: { x: 8, y: 8 } })
    expect(open).not.toHaveBeenCalled()
  })
})
