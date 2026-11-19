import { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { LocalizationProvider } from '@/i18n'
import { AgentWatchScreen } from '@/components/session-watch/AgentWatchChrome'
import { PhoneWatchWindow } from '@/components/session-watch/PhoneWatchWindow'
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view'
import { loadChatUi } from '@renderer/lib/chat/chat-transcript'
import { LiveWindowModel } from '@renderer/features/live-window/model'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/components/session-watch/agent-watch.css'
import '@/components/session-watch/phone-conversation.css'

it('keeps the floating picture above the shared composer through header hiding and enlargement', async () => {
  await page.viewport(390, 844)
  const { createChatContext, createChatState } = await loadChatUi()
  const context = createChatContext({ locale: () => 'en-US' })
  const state = createChatState(context)
  const host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.style.cssText = 'display:flex;width:390px;height:700px;overflow:hidden'
  const root = createRoot(host)
  const model = new LiveWindowModel('phone')
  const live = { conversationId: 'private', deviceId: 'machine', sessionId: 'task', agentId: 'agent', privateAgentChat: true, shown: true }
  model.activate(live)
  model.observe(live, [{ id: 'web', kind: 'browser', deviceId: 'machine', sessionId: 'task', agentId: 'agent', title: 'Page',
    size: { width: 1280, height: 900 }, status: 'operating' }])
  function View() {
    const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
    return <LocalizationProvider><AgentWatchScreen title="Agent" testId="phone-watch-chat" bodyFill onBack={vi.fn()}>
      <div data-phone-live-conversation style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <PhoneWatchWindow sources={snapshot.sources.map(source => ({ ...source, picture: <div /> }))}
          selectedId={snapshot.source!.id} presentation={snapshot.presentation!} visible={snapshot.visible}
          dispatch={action => model.dispatch(action)} onError={error => { throw error }}>
          <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
            <AgentConversationView context={context} state={state} composerPlacement="bottom" style={{ position: 'absolute', inset: 0 }}
              composerContent={<div style={{ height: 108 }}><textarea aria-label="Reply" /></div>} />
          </div>
        </PhoneWatchWindow>
      </div>
    </AgentWatchScreen></LocalizationProvider>
  }
  try {
    await act(async () => root.render(<View />))
    const window = () => host.querySelector<HTMLElement>('[data-phone-watch-window]')!
    const composer = () => host.querySelector<HTMLElement>('[data-chat-composer-placement="bottom"]')!
    await until('floating picture clears the measured composer', () => ({ height: composer()?.getBoundingClientRect().height, width: window()?.offsetWidth,
      pictureBottom: window()?.getBoundingClientRect().bottom, composerTop: composer()?.getBoundingClientRect().top }),
      value => (value.height ?? 0) >= 108 && value.width === 160 && value.pictureBottom <= value.composerTop - 15)
    const body = host.querySelector<HTMLElement>('.gg-aw-body')!.getBoundingClientRect()
    const layout = host.querySelector<HTMLElement>('[data-phone-watch-layout]')!.getBoundingClientRect()
    expect(layout.left).toBe(body.left)
    expect(layout.right).toBe(body.right)
    expect(window().getBoundingClientRect().bottom).toBeLessThanOrEqual(composer().getBoundingClientRect().top - 15)
    await act(async () => model.dispatch({ type: 'toggle-window' }))
    expect(window().hidden).toBe(true)
    expect(host.querySelector('[data-phone-watch-handle]')).toBeNull()
    await act(async () => model.dispatch({ type: 'toggle-window' }))
    expect(window().hidden).toBe(false)
    await act(async () => model.dispatch({ type: 'enlarge' }))
    await until('chat flows below the enlarged picture', () => host.querySelector('[data-chat-scroll]')!.getBoundingClientRect().top >= window().getBoundingClientRect().bottom)
    expect(composer().getBoundingClientRect().bottom).toBeLessThanOrEqual(body.bottom)
  } finally {
    await act(async () => root.unmount())
    host.remove(); state.dispose(); context.dispose()
  }
})
