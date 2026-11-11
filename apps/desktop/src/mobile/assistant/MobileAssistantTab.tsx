import { useEffect, useSyncExternalStore } from 'react'
import type { AssistantChatHandlers } from '@/components/assistant/AssistantChatSlot'
import { MobileAssistantApp } from './MobileAssistantApp'
import { MobileAssistantGate } from './MobileAssistantGate'
import type { PhoneAssistantState } from './usePhoneAssistant'
import { useAuth } from '@/store/auth'
import { memberFace } from '@/lib/memberFaces'
import { getCloudComputerState, subscribeCloudComputerState } from '@/lib/cloudComputerStore'
import { phoneAssistantLayer } from '@/components/appSlot/phoneAssistantLayer'
import { phoneAssistantStatusOf } from './phoneAssistantEntry'

/**
 * #7199 手机上的咕咕:「消息」置顶第一行推进来的整屏一层(owner 10-26,OpenDCAI/gugu#446;取代 10-16「底栏里的一格」)。
 * 能打开和它的私聊 = 助理 App 本身;还不能(没开通 / 正在准备 / 读不到 / 私聊在开)= 同一层里说是哪一步。
 */
export function MobileAssistantTab({ state, visible, chatRequest, navigationTarget, onExit, ...chatHandlers }: {
  state: PhoneAssistantState
  visible: boolean
  /** 每变一次 = 别处打开了和它的私聊(对话列表、通知、联系人「发消息」):落在聊天那一段。 */
  chatRequest: number
  navigationTarget?: boolean
  /** 页头左上返回:退回「消息」。 */
  onExit?: () => void
} & AssistantChatHandlers) {
  usePhoneAssistantStatusForApps(state)
  if (state.stage.stage !== 'ready' || !state.assistant || !state.chatId) {
    return <MobileAssistantGate stage={state.stage.stage === 'ready' ? { stage: 'chat-opening' } : state.stage} name={state.assistant?.display_name ?? null} ownerName={state.ownerName} onExit={onExit} />
  }
  return (
    <MobileAssistantApp
      chatId={state.chatId}
      assistant={state.assistant}
      ownerName={state.ownerName}
      homeDeviceId={state.homeDeviceId}
      cloudDeviceId={state.cloudDeviceId}
      home={state.home}
      visible={visible}
      chatRequest={chatRequest}
      navigationTarget={navigationTarget}
      onExit={onExit}
      {...chatHandlers}
    />
  )
}

/**
 * API 49 The assistant as an App may see it (`gugu.assistant.status`), from what this layer knows, for the account signed in:
 * handed to the phone's binding host (phoneAssistantLayer) each time it changes; nothing while nobody is signed in.
 */
function usePhoneAssistantStatusForApps(state: PhoneAssistantState) {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  const cloud = useSyncExternalStore(subscribeCloudComputerState, getCloudComputerState, getCloudComputerState)
  const assistantId = state.assistant?.id ?? null
  const avatar = state.assistant?.avatar ?? null
  const cloudFacts = { available: !!cloud?.available, state: cloud?.snapshot?.state ?? null, loadError: cloud?.loadError ?? null }
  const key = JSON.stringify([ownerId, user?.nickname ?? null, state.stage.stage, (state.stage as { state?: string }).state ?? null, state.assistant, state.home, cloudFacts])
  useEffect(() => {
    if (!ownerId) {
      phoneAssistantLayer.publishStatus(null)
      return undefined
    }
    let stale = false
    void (assistantId ? memberFace(assistantId, avatar).catch(() => null) : Promise.resolve(null)).then((face) => {
      if (!stale) phoneAssistantLayer.publishStatus({ ownerId, status: phoneAssistantStatusOf(state, face, cloudFacts, user?.nickname ?? null) })
    })
    return () => { stale = true }
    // The key holds everything the status is read from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
