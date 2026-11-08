import { useCallback, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { activityPreviewLabel, type ActivityPreviewSource } from '@gugu/session-chat-ui/activity-preview'
import { chatActor } from '@/session/renderer/lib/chat/actor-identity'
import { chatDisplayName } from '@/session/renderer/lib/chat/chat-name'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { readChatSummary, resolveChatId, useChatSummaries } from '@/lib/chatSummariesBridge'
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge'

const subscribeNone = () => () => undefined
const noSnapshot = () => null

/** The same viewer facts and semantic copy as transcript folds and task search. */
export function useActivityPreviewText() {
  const directory = readIdentityDirectoryBridge()
  const self = readSelfIdentityBridge()
  const identities = useSyncExternalStore(directory?.subscribe ?? subscribeNone, directory?.getSnapshot ?? noSnapshot)
  const viewer = useSyncExternalStore(self?.subscribe ?? subscribeNone, self?.getSnapshot ?? noSnapshot)
  const summaries = useChatSummaries()
  const { i18n } = useTranslation()
  return useCallback((source: ActivityPreviewSource | null | undefined) => activityPreviewLabel(source, {
    actor: chatActor, viewerId: viewer?.userId, chatName: chatDisplayName,
    chatKind: id => readChatSummary(resolveChatId(id) ?? id)?.kind ?? null,
    translate: translateSessionMessage,
  }), [identities, viewer, summaries, i18n.resolvedLanguage])
}
