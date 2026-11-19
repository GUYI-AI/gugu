// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatContext, ChatState, ChatViewOptions } from '@gugu/session-chat-ui'
import { createReactHarness } from '../../../support/testHarness'
import { SurfaceShown } from '@/lib/retainedSurface'
import { ChatTranscript, loadChatUi } from '@renderer/lib/chat/chat-transcript'

const scope = vi.hoisted(() => ({ shown: undefined as boolean | undefined, creates: 0, change: vi.fn() }))
vi.mock('@gugu/session-chat-ui', () => ({ createChatView: (options: ChatViewOptions) => {
  scope.shown = options.shown; scope.creates++
  return { setShown: scope.change, setCommands: () => {}, setPinUserMessages: () => {}, setModel: () => {}, setContentPadding: () => {}, dispose: () => {} }
} }))
const harness = createReactHarness()
afterEach(() => { harness.cleanup(); scope.change.mockClear(); scope.creates = 0 })

it('follows its surfaces (task frame, page, tab) without recreating the retained view', async () => {
  await loadChatUi()
  const context = {} as ChatContext, state = {} as ChatState
  const tree = (page: boolean, tab: boolean, frame = true) => (
    <SurfaceShown shown={frame}><SurfaceShown shown={page}><SurfaceShown shown={tab}>
      <ChatTranscript context={context} state={state} />
    </SurfaceShown></SurfaceShown></SurfaceShown>
  )
  await harness.render(tree(false, true))
  expect(scope.shown).toBe(false)
  expect(scope.change).toHaveBeenLastCalledWith(false)
  await harness.render(tree(true, true))
  expect(scope.change).toHaveBeenLastCalledWith(true)
  await harness.render(tree(true, false))
  expect(scope.change).toHaveBeenLastCalledWith(false)
  await harness.render(tree(true, true, false))
  expect(scope.change).toHaveBeenLastCalledWith(false)
  await harness.render(tree(true, true))
  expect(scope.change).toHaveBeenLastCalledWith(true)
  expect(scope.creates).toBe(1)
})
