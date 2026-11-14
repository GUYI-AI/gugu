import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { QUICK_CHAT_CHANNELS, QUICK_CHAT_WINDOW_NAME } from '../../lib/quickChatIpc'
import { rendererLogger } from '../../lib/log'
import { UI_EVENTS } from '../../lib/uiEvents'
import { openAssistantEntry } from '../../lib/assistantEntry'
import { desktopIpc } from '../../platform/desktopIpc'
import { mirrorDocument } from '../../session/renderer/lib/aux-document'
import { QuickChat, type QuickChatAssistant } from './QuickChat'
import { quickChatShortcutLabel, useQuickChatState } from './useQuickChatState'

const log = rendererLogger('assistant/quick-chat')

type Mounted = { win: Window; root: HTMLElement }

/** The small window this renderer opened last; the one to use again while it is not really closed. */
let keptWindow: Window | null = null

/**
 * Opening is idempotent: the window opened before is used again while it is open (the main process turns 「close」 into
 * 「hide」, so a hidden one is still open), and `window.open` is asked only when there is none. ❌ `window.open('about:blank',
 * name)` for a name that already has a window: Chromium hands that window back and navigates it, and the navigation lands
 * after what was drawn into it and empties it (the second run of this effect under StrictMode, sign-out then sign-in, a new
 * `generation`). The address stays empty so that a window that exists is handed back as it is; a name without one gets
 * the same blank window (the main process adopts either, `isAuxWindowRequest`).
 */
function openQuickChatWindow(): Window | null {
  if (keptWindow && !keptWindow.closed) return keptWindow
  keptWindow = window.open('', QUICK_CHAT_WINDOW_NAME, 'width=520,height=680')
  return keptWindow
}

type QuickChatFrame = { root: HTMLElement; stopMirror: () => void; erase: () => void }

/**
 * Draws the frame the quick chat is portaled into: the opener's styles mirrored, an empty root. All or nothing: a step that
 * fails takes back what the steps before it wrote, so the window is never left half drawn (and the page goes on).
 */
function drawQuickChatFrame(win: Window): QuickChatFrame {
  const doc = win.document
  const erase = () => {
    doc.head.replaceChildren()
    doc.body.replaceChildren()
  }
  // The same window is used again: clear what the last run left.
  erase()
  let stopMirror = () => {}
  try {
    stopMirror = mirrorDocument(document, doc)
    Object.assign(doc.body.style, { margin: '0', height: '100vh', overflow: 'hidden' })
    const root = doc.createElement('div')
    doc.body.append(root)
    return { root, stopMirror, erase }
  } catch (error) {
    stopMirror()
    erase()
    throw error
  }
}

/**
 * #7199「快速聊天」在主窗这一侧的那一半:登录着就预先开好那扇小窗(同源子窗,主进程照 quick-chat-window.ts 配外观、藏着),
 * 按快捷键时主进程直接把它摆出来 —— 不等加载。界面由这里画进去(同一份登录、数据、实时)。
 * 小窗被真关了(主窗重载会关掉所有子窗)/ 还没开时按快捷键:主进程说一声 open,这里重开一扇。
 * 只在桌面版:网页与手机没有全局快捷键,也没有子窗。
 */
export function QuickChatHost({
  assistant,
  assistantState,
  chatId,
  chatFailed,
  retryChat,
}: {
  assistant: QuickChatAssistant | null
  assistantState: 'found' | 'loading' | 'none' | 'unreadable'
  chatId: string | null
  chatFailed: { error: string } | null
  retryChat: () => void
}) {
  const { t } = useTranslation('assistant')
  // desktopIpc() 每次给一个新对象:定在挂上那一刻(❌ 每画一次就当成换了一条线、把小窗重开一遍)。
  const [ipc] = useState(desktopIpc)
  const [mounted, setMounted] = useState<Mounted | null>(null)
  const [generation, setGeneration] = useState(0)
  const [visible, setVisible] = useState(false)
  const { state } = useQuickChatState()
  const mountedRef = useRef<Mounted | null>(null)
  mountedRef.current = mounted

  // Subscribe before window.open: adoption can show a pending shortcut window immediately.
  useLayoutEffect(() => {
    if (!ipc) return
    const offOpen = ipc.eventOn(QUICK_CHAT_CHANNELS.open, () => {
      const current = mountedRef.current
      if (!current || current.win.closed) setGeneration((n) => n + 1)
    })
    const offVisibility = ipc.eventOn(QUICK_CHAT_CHANNELS.visibility, (shown) => setVisible(shown === true))
    return () => {
      offOpen()
      offVisibility()
    }
  }, [ipc])

  useLayoutEffect(() => {
    if (!ipc) return
    const win = openQuickChatWindow()
    if (!win) {
      log.warn({}, '快速聊天的小窗没开出来')
      return
    }
    let frame: QuickChatFrame
    try {
      frame = drawQuickChatFrame(win)
    } catch (error) {
      log.warn({ error: String(error) }, 'The quick chat window could not be drawn into')
      return
    }
    const { root } = frame
    const onGone = () => setMounted((current) => (current?.win === win ? null : current))
    win.addEventListener('pagehide', onGone)
    setMounted({ win, root })
    return () => {
      win.removeEventListener('pagehide', onGone)
      frame.stopMirror()
      setMounted(null)
      if (!win.closed) {
        frame.erase()
        // 主进程把「关」当「收起」:这扇留着(藏着),下次登录再用同一扇。
        win.close()
      }
    }
  }, [ipc, generation])

  const name = assistant?.display_name ?? t('quickChat.assistant')
  useEffect(() => {
    if (mounted) mounted.win.document.title = t('quickChat.title', { name })
  }, [mounted, name, t])

  if (!ipc || !mounted) return null
  const shortcut = state ? quickChatShortcutLabel(state) : ''
  return createPortal(
    <QuickChat
      assistant={assistant}
      assistantState={assistantState}
      chatId={chatId}
      chatFailed={chatFailed}
      retryChat={retryChat}
      visible={visible}
      shortcut={shortcut}
      onClose={() => void ipc.invoke(QUICK_CHAT_CHANNELS.hide)}
      onOpenMain={() => {
        // 去主窗里的「助理」:有它 = 和它的聊天;还没有 = 开通那一页(同一个视图)。装好、绑好了助理 App = 去 App(lib/assistantEntry)。
        window.dispatchEvent(new Event(UI_EVENTS.sessionpageReveal))
        openAssistantEntry()
        void ipc.invoke(QUICK_CHAT_CHANNELS.openMain)
      }}
    />,
    mounted.root
  )
}
