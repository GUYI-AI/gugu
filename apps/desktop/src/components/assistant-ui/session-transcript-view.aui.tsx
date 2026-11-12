import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { ChatCommands, ChatContext, ChatLayout, ChatState } from '@gugu/session-chat-ui'
import type { TimelineWindowFields } from '@gugu/session-core/session-record/contract'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { loadChatUi } from '@renderer/lib/chat/chat-transcript'
import { useSessionChatLayout } from '@renderer/lib/chat/use-session-chat-layout'
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view'
import { createSessionChatContext } from '@renderer/lib/chat/shared-chat-context'
import { applyTranscriptSnapshot, planHistorySync, splitActiveTurn } from './transcript-sync'
import { QueryClientProvider } from '@tanstack/react-query'
import { batch } from 'solid-js'
import { queryClient } from '@renderer/lib/query-client'
import { useMobileShell } from '@/hooks/useMobileShell'

export type SessionBackgroundTasks = Parameters<ChatState['session']['setBackgroundTasks']>[0]

const NO_BACKGROUND_TASKS: SessionBackgroundTasks = { commands: [], subagents: [] }

type Model = { uri: string; context: ChatContext; state: ChatState }

/**
 * 一整条会话的转录(session-chat-ui,任务页同一个组件),从 React 页面里画。数据是一份完整的时间线
 * (`TranscriptTurn[]`,比如 `useTimelineSession` 读回来的,或再按私聊筛过的):最后一轮没收尾就是正在进行的那一轮。
 *
 * 它自己有一个 ChatContext:layout 设在 context 上,❌ 用 `getSharedChatContext()` —— 那样设了
 * `agentConversation` 会把同一个窗口里别的转录(投递卡、思考行)一起改掉。
 *
 * `mobile`:手机壳里画(窄屏、底部安全区)。点按、展开这些交互由转录自己按视口处理。
 */
export function SessionTranscriptView(props: Parameters<typeof SessionTranscriptContent>[0]): ReactElement {
  return <QueryClientProvider client={queryClient}><SessionTranscriptContent {...props} /></QueryClientProvider>
}

function SessionTranscriptContent({
  uri,
  turns,
  layout,
  commands,
  sourceWindow,
  composerContent,
  shown,
  onVisibleItems,
  onAtBottomChange,
  onReady,
  activeTurnId,
  pendingPrompt,
  pendingMessages,
  backgroundTasks,
  onReachStart,
  contentOverlay = false,
  mobile = false,
  className,
  style,
}: {
  /** 这条会话的身份(换会话 = 换一份 ChatState)。 */
  uri: string
  turns: readonly TranscriptTurn[]
  layout?: ChatLayout
  sourceWindow?: TimelineWindowFields
  commands?: ChatCommands
  composerContent?: ReactNode
  /** A layer over the messages, under the composer (`onReady`'s `contentOverlay`): loading draws its skeleton there. */
  contentOverlay?: boolean
  shown?: boolean
  activeTurnId?: string | null
  pendingPrompt?: import('@gugu/session-chat-ui').PendingPrompt | null
  pendingMessages?: readonly import('@gugu/session-chat-ui').PendingPrompt[]
  onReady?: import('@renderer/lib/chat/chat-transcript').ChatTranscriptProps['onReady']
  onAtBottomChange?: (atBottom: boolean) => void
  onVisibleItems?: (ids: readonly string[]) => void
  /** 此刻还在跑的后台任务(宿主算好的两份名单);不给 = 没有。 */
  backgroundTasks?: SessionBackgroundTasks
  /** 滚到顶了:往前翻更早的轮。 */
  onReachStart?: () => void | Promise<unknown>
  mobile?: boolean
  className?: string
  style?: CSSProperties
}): ReactElement | null {
  const defaultLayout = useSessionChatLayout()
  const mobileShell = useMobileShell()
  // On the phone a tool call's pictures are not drawn or fetched (#2594); the desktop keeps them, however narrow.
  // Gated on the shell, not on `mobile`: desktop windows (the assistant's task window, a peek) draw this same page.
  const baseLayout = layout ?? defaultLayout
  const shownLayout = useMemo(() => mobileShell ? { ...baseLayout, hideToolPictures: true } : baseLayout, [baseLayout, mobileShell])
  const [model, setModel] = useState<Model | null>(null)
  const written = useRef<readonly TranscriptTurn[]>([])
  const viewCommands = useMemo(() => ({ ...commands, sourceWindow }), [commands, sourceWindow])

  useEffect(() => {
    let live = true
    let created: Model | null = null
    void loadChatUi().then(({ createChatState }) => {
      if (!live) return
      const context = createSessionChatContext()
      created = { uri, context, state: createChatState(context, { uri }) }
      written.current = []
      setModel(created)
    })
    return () => {
      live = false
      if (created) {
        created.state.dispose()
        created.context.dispose()
      }
      setModel(null)
    }
  }, [uri])

  // 画之前写进去:❌ 先画一帧空转录、下一帧才长出正文。
  // 转录、pendingPrompt、pendingMessages 是同一次写入(一个 Solid batch,#2296):分成三次的话,输入落地那一拍
  // 转录里已经有了它、待发那一份还在(或反过来),逐行的转录先看到半更新的列表,把那条气泡的行卸掉再新挂一份 DOM。
  const applied = useRef<{ model?: Model; turns?: readonly TranscriptTurn[]; activeTurnId?: string | null; pendingPrompt?: unknown; pendingMessages?: unknown }>({})
  useLayoutEffect(() => {
    if (!model) return
    const last = applied.current
    const fresh = last.model !== model
    batch(() => {
      if (fresh || last.turns !== turns || last.activeTurnId !== activeTurnId) {
        const { settled, active } = activeTurnId === undefined ? splitActiveTurn(turns)
          : { settled: turns.filter(turn => turn.id !== activeTurnId), active: turns.find(turn => turn.id === activeTurnId) ?? null }
        const plan = planHistorySync(written.current, settled)
        applyTranscriptSnapshot(model.state.transcript, plan, active)
        written.current = settled
      }
      if (fresh || last.pendingPrompt !== pendingPrompt) model.state.session.setPendingPrompt(pendingPrompt ?? null)
      if (fresh || last.pendingMessages !== pendingMessages) model.state.session.setPendingMessages(pendingMessages ?? [])
    })
    applied.current = { model, turns, activeTurnId, pendingPrompt, pendingMessages }
  }, [model, turns, activeTurnId, pendingPrompt, pendingMessages])

  useEffect(() => {
    model?.state.session.setBackgroundTasks(backgroundTasks ?? NO_BACKGROUND_TASKS)
  }, [model, backgroundTasks])

  if (!model) return null
  return (
    <AgentConversationView
      context={model.context}
      state={model.state}
      pinUserMessages={!mobileShell}
      commands={viewCommands}
      composerContent={composerContent}
      shown={shown}
      onVisibleItems={onVisibleItems}
      onAtBottomChange={onAtBottomChange}
      onReady={onReady}
      composer="none"
      stickToBottom
      layout={shownLayout}
      onReachStart={onReachStart}
      contentOverlay={contentOverlay}
      className={[mobile ? 'gg-session-transcript gg-session-transcript--mobile' : 'gg-session-transcript', className].filter(Boolean).join(' ')}
      style={style}
    />
  )
}
