import '@/i18n/registerAssistantCatalog'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useMemo } from 'react'
import type { ChatChannelList, ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { rendererChatChannelsClient } from '@/lib/chatChannels'
import { useReplica } from '@/lib/replica'
import { chatChannels, watchConnections } from '@/components/connections/connection-replicas'

export type ChatChannelsStatus = 'loading' | 'ready' | 'absent' | 'failed'

/**
 * The WeChat (chat channel) connection: the `chatChannels` replica (account scope, connection-replicas.ts). `status` is the
 * reading said in this surface's words: unknown → `loading`, the cloud computer not open → `absent`, failed with nothing
 * read → `failed`; a refresh that fails over a value keeps it and says `error`.
 */
export function useChatChannels(): {
  client: ChatChannelsClient | null; list: ChatChannelList | null; status: ChatChannelsStatus; error: string
  refresh: () => Promise<void>; apply: (next: ChatChannelList) => void
} {
  const { t } = useTranslation('assistant')
  const client = useMemo(() => rendererChatChannelsClient(), [])
  const reading = useReplica(chatChannels, [])
  useEffect(() => watchConnections(), [])
  // A change this surface made answers with the whole list after an await: put it in the account this render drew (the
  // handler holds this `apply` across its await), ❌ whichever account is signed in when it answers.
  const owner = chatChannels.key()?.[1] ?? null
  const entry = useMemo(() => (owner ? chatChannels.at() : null), [owner])
  const apply = useCallback((next: ChatChannelList) => { entry?.set(next) }, [entry])
  const refresh = useCallback(() => chatChannels.refresh(), [])
  if (reading.state === 'unknown') return { client, list: null, status: 'loading', error: '', refresh, apply }
  if (reading.state === 'error') return { client, list: null, status: 'failed', error: t('connectors.loadFailed'), refresh, apply }
  const value = reading.value
  if ('absent' in value) return { client, list: null, status: 'absent', error: '', refresh, apply }
  return { client, list: value, status: 'ready', error: reading.error ? t('connectors.loadFailed') : '', refresh, apply }
}
