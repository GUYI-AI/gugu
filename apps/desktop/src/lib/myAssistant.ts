import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { identityDb } from './supabase'
import { rendererLogger } from './log'
import { ASSISTANT_PROVISION_SELECT, pickAssistant, type AssistantProvisionRow } from './assistantProvision'
import { replica, useReplica, type Reading } from './replica'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from './realtimeChannel'
import { useAuth } from '../store/auth'
import type { ContactsLoadStatus } from '../store/contactsContext'

/**
 * 这个人的个人助理是谁(按库里的标记 `agent_provisions.member_key='assistant'`,不论它住在云上还是哪台电脑上)。
 * `provisionDeviceId`:库里那一行记的是哪台(建它 / 最近一次搬过去的);它此刻住哪以通讯录为准,见 `useMyAssistantContact`。
 * `agentId: null` = 读到了,这个人还没有个人助理。
 */
export type MyAssistant = { agentId: string | null; provisionDeviceId: string | null }

const log = rendererLogger('assistant/identity')

async function readMyAssistant(owner: string): Promise<MyAssistant> {
  const { data, error } = await identityDb
    .from('agent_provisions')
    .select(ASSISTANT_PROVISION_SELECT)
    .eq('member_key', 'assistant')
    .eq('owner_user_id', owner)
  if (error) {
    // 读不到 ≠ 没有助理:读数就是错误,由看的一方说「读不到」。
    log.error({ error: error.message }, 'read assistant provision failed')
    throw new Error(error.message)
  }
  const pick = pickAssistant((data ?? []) as AssistantProvisionRow[])
  return { agentId: pick?.agentId ?? null, provisionDeviceId: pick?.deviceId ?? null }
}

/**
 * @@@client-state-model, signal tier: `agent_provisions` writes no account revision (gugu-supabase dev 5f12312: its only
 * trigger stamps device commands; `agent_changed` comes from `identity.users`). So the value is read again when the window
 * comes back past `fresh`, when the account's private bus resubscribes (a gap where another device may have provisioned or
 * moved it), on `agent_changed` (creating an assistant adds a users row: a hint; store/contacts.tsx), and after this
 * device's own provision / move / close writes (`refreshMyAssistant`: a write without a version).
 * Kept across restarts so the left-rail entry is there on the first frame.
 */
export const myAssistant = replica({
  name: 'myAssistant',
  scope: 'account',
  read: (owner: string): Promise<MyAssistant> => readMyAssistant(owner),
  fresh: 60_000,
  refreshOnFocus: true,
  // `{agentId, provisionDeviceId}`: two uuids, ~120 B.
  persist: { maxBytes: 256, maxEntries: 1 },
  // One bus listener per account while anything shows it. The bus carries no provision event; only its resubscription
  // matters here (signal tier: invalidate on resume). The first subscription is not a resume.
  watch: {
    start: (owner) => {
      let resumed = false
      const onSubscribed = () => { if (resumed) void myAssistant.refresh(); resumed = true }
      const handle = subscribePrivateUserEventBus(owner, 'im_revision_advanced', () => undefined, { onSubscribed })
      return () => unsubscribePrivateUserEventBus(handle)
    },
  },
})

/** A provision / move / close just landed: that row was just written, read it again (❌ wait for contacts to change — a move adds no agent). */
export function refreshMyAssistant(): Promise<void> {
  return myAssistant.refresh()
}

/** This account's personal assistant: unknown until read, then who it is (or that there is none), or why it could not be read. */
export function useMyAssistant(): Reading<MyAssistant> {
  const ownerUserId = useAuth().user?.id ?? null
  return useReplica(myAssistant, ownerUserId ? [] : null)
}

/**
 * 壳这一侧(左栏那一格、App 的壳一半、手机)要的是通讯录里的那一位:按标记认出 id,再到通讯录里取头像、名字和它住的那台
 * (`homeDeviceId`:通讯录里它的 `device_id`,搬家落定时改的就是它;通讯录还没跟上时退回库里那一行记的那台)。
 */
export function useMyAssistantContact(contacts: readonly ContactUser[]) {
  const reading = useMyAssistant()
  const agentId = reading.state === 'value' ? reading.value.agentId : null
  const contact = agentId ? contacts.find((c) => c.id === agentId) ?? null : null
  const homeDeviceId = contact?.device_id ?? (reading.state === 'value' ? reading.value.provisionDeviceId : null)
  return { reading, contact, homeDeviceId }
}

/**
 * 个人助理此刻认到哪一步:库里的标记认出是谁,再到通讯录里取那一位。
 * #7408 认出了是谁、通讯录却没读成(里头没有它):说读不到,❌ 一直「正在读」。
 */
export function assistantIdentityState(
  inContacts: boolean,
  mine: Reading<MyAssistant>,
  contactsStatus: ContactsLoadStatus,
): 'found' | 'loading' | 'unreadable' | 'none' {
  if (inContacts) return 'found'
  if (mine.state === 'unknown') return 'loading'
  if (mine.state === 'error') return 'unreadable'
  if (mine.value.agentId) return contactsStatus === 'error' ? 'unreadable' : 'loading'
  return 'none'
}
