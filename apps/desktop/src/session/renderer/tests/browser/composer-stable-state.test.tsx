import { createRef, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Editor } from '../../../../../../../packages/session-ui/node_modules/@tiptap/core'
import { ChatComposer, type ContextMentionProvider, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

let root: Root
let container: HTMLDivElement
let api: ReturnType<typeof createRef<PromptEditorRef>>
const editor = () => container.querySelector<HTMLElement & { editor: Editor }>('[data-testid="prompt-editor"]')!.editor

beforeEach(() => {
  container = document.createElement('div')
  container.className = 'gugu-skin'
  document.body.appendChild(container)
  root = createRoot(container)
  api = createRef<PromptEditorRef>()
})
afterEach(() => {
  const instance = editor()
  root.unmount()
  if (!instance.isDestroyed) instance.destroy()
  container.remove()
  vi.restoreAllMocks()
})
async function render(onChange = vi.fn(), disabled = false, mentionProvider?: ContextMentionProvider) {
  await act(async () => root.render(<SessionLocalizationProvider>
    <ChatComposer editorApiRef={api} onInputChange={onChange} onSubmit={() => {}} disabled={disabled} mentionProvider={mentionProvider} />
  </SessionLocalizationProvider>))
  await until('editor initialized', () => Boolean(api.current && editor()?.isInitialized))
}

it('keeps editor options stable on host renders and still reads new callbacks and disabled state', async () => {
  await render()
  const instance = editor()
  const options = vi.spyOn(instance, 'setOptions')
  const changed = vi.fn()
  await render(changed)
  expect(editor()).toBe(instance)
  expect(options).not.toHaveBeenCalled()
  await act(async () => api.current!.setText('new draft'))
  expect(changed).toHaveBeenLastCalledWith('new draft')
  await render(changed, true)
  expect(instance.view.dom.getAttribute('aria-disabled')).toBe('true')
})

it('keeps the exact document, caret and update history when restoring the same draft', async () => {
  const changed = vi.fn()
  await render(changed)
  await act(async () => api.current!.setText('same draft'))
  editor().view.dom.focus()
  const range = document.createRange()
  range.setStart(editor().view.dom.querySelector('p')!.firstChild!, 2)
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  await until('caret is inside the draft', () => editor().state.selection.from === 3)
  const state = editor().state
  changed.mockClear()
  await act(async () => api.current!.setText('same draft'))
  expect(editor().state).toBe(state)
  expect(editor().state.selection.from).toBe(3)
  expect(changed).not.toHaveBeenCalled()
  await act(async () => api.current!.setText('different draft'))
  expect(api.current!.getText()).toBe('different draft')
  expect(changed).toHaveBeenLastCalledWith('different draft')
})

it('applies changed mention metadata even when the serialized draft stays the same', async () => {
  const provider = (pending: boolean): ContextMentionProvider => ({
    search: async () => [],
    resolve: target => ({ id: target, label: target, kind: 'file', pending }),
  })
  await render(vi.fn(), false, provider(true))
  await act(async () => api.current!.setText('@[file.ts](file.ts)'))
  expect(editor().state.doc.firstChild!.firstChild!.attrs.pending).toBe(true)
  await render(vi.fn(), false, provider(false))
  await act(async () => api.current!.setText('@[file.ts](file.ts)'))
  expect(editor().state.doc.firstChild!.firstChild!.attrs.pending).toBe(false)
})
