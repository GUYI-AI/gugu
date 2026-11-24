import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { identityDb } from './supabase'
import { rendererLogger } from './log'
import { ASSISTANT_BINDING_ARGS, ASSISTANT_BINDING_RPC, pickAssistant } from './assistantProvision'
import { replica, useReplica, type Reading } from './replica'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from './realtimeChannel'
import { useAuth } from '../store/auth'
import type { ContactsLoadStatus } from '../store/contactsContext'

/** 这个人的个人助理是谁(助理 App 在账号上绑定的 agent,`my_app_agent`);`provisionDeviceId` = 它现在住的那台;`agentId: null` = 读到了、还没有。 */
export type MyAssistant = { agentId: string | null; provisionDeviceId: string | null }

const log = rendererLogger('assistant/identity')

async function readMyAssistant(_owner: string): Promise<MyAssistant> {
  const { data, error, status } = await identityDb
    .rpc(ASSISTANT_BINDING_RPC, ASSISTANT_BINDING_ARGS)
  if (error) {
    // 读不到 ≠ 没有助理:读数就是错误,由看的一方说「读不到」。带着 code / status(瞬时的还是固定的,看的一方据此说)。
    log.error({ error: error.message }, 'read assistant binding failed')
    throw Object.assign(new Error(error.message), { code: error.code, status })
  }
  const pick = pickAssistant(data)
  return { agentId: pick?.agentId ?? null, provisionDeviceId: pick?.deviceId ?? null }
}

/**
 * @@@client-state-model, signal tier: `agent_provisions` writes no account revision (gugu-supabase dev 5f12312): read again on
 * focus, bus resubscribe, `agent_changed` and this device's own writes (a provision / move / close just landed: ❌ wait for
 * contacts to change — a move adds no agent). Kept for the first frame.
 */
export const myAssistant = replica({
  name: 'myAssistant',
  scope: 'account',
  read: (owner: string): Promise<MyAssistant> => readMyAssistant(owner),
  fresh: 60_000,
  refreshOnFocus: true,
  // A network blip is not an answer: asked twice more before the reading is an error (the panel path did the same).
  retry: 2,
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
  // "None" kept from an earlier read whose read again failed: not known now (another device may have made one since).
  return mine.error ? 'unreadable' : 'none'
}
