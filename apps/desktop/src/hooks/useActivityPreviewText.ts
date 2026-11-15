import { useCallback, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { activityPreviewLabel, type ActivityPreviewSource } from '@gugu/session-chat-ui/activity-preview'
import { chatActor } from '@/session/renderer/lib/chat/actor-identity'
import { chatDisplayName } from '@/session/renderer/lib/chat/chat-name'
import { registerSessionLocaleResources } from '@/session/renderer/localization/locale-store'
import { chatNamesVersion, readChatSummary, resolveChatId, subscribeChatNames } from '@/lib/chatSummariesBridge'
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
  // A new function when a chat's name or kind arrives or changes: callers cache the text per row. A message does not change it.
  const names = useSyncExternalStore(subscribeChatNames, chatNamesVersion)
  registerSessionLocaleResources()
  const { t } = useTranslation('session')
  return useCallback((source: ActivityPreviewSource | null | undefined) => activityPreviewLabel(source, {
    actor: address => chatActor(address, directory ? { ...directory, getSnapshot: () => identities } : undefined),
    viewerId: viewer?.userId, chatName: chatDisplayName,
    chatKind: id => readChatSummary(resolveChatId(id) ?? id)?.kind ?? null,
    translate: (key, values) => t(key, { ...values, interpolation: { prefix: '{', suffix: '}' } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `names` stands for what chatKind and chatName read when drawn
  }), [directory, identities, viewer, t, names])
}
