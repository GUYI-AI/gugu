import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import { withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'
import { pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision'
import { userIdFromSupabaseAccessToken } from '@gugu/core/cloud/runtimeAuthProvider'
import type { AssistantPanelClient } from '@gugu/core/cloud/assistantPanel'
import { requireAssistantPanelBridge } from '../../lib/assistantPanelBridge'
import { composeChatDraft } from '../../lib/composeDraft'
import { getRendererAccessToken } from '../../lib/sessionPublication'
import { chatDb, identityDb } from '../../lib/supabase'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import type { createAppFiles } from '../../session/shared/extensions/app-files-core'
import { phoneApps } from './phoneApps'
import { phoneAssistantLayer } from './phoneAssistantLayer'
import type { PhoneBindingPorts, PhoneInstalledApp } from './phoneAppBindings'

const failed = (message: string) => Object.assign(new Error(message), { code: 'failed' })

// What `pickAssistant` reads, plus the private conversation and the identity's owner (as the desktop's resources read it).
const PERSONAL_ASSISTANT_SELECT = 'agent_user_id,device_id,member_key,phase,created_at,dm_chat_id,agent:users!agent_provisions_agent_user_id_fkey(owner_user_id,removed_at)'

/**
 * The assistant panel's client as the person (assistant-panel-cloud.ts), loaded when first asked: a page whose Apps never
 * reach the binding never loads the panel's outbox and session watch.
 */
const panelCloud = () => import('../assistant/assistant-panel-cloud').then((module) => module.assistantPanelCloud)
const lazyPanelClient = {
  snapshot: async (assistant: string) => (await panelCloud()).snapshot(assistant),
  resource: async (...args: Parameters<AssistantPanelClient['resource']>) => (await panelCloud()).resource(...args),
  commit: async (...args: Parameters<AssistantPanelClient['commit']>) => (await panelCloud()).commit(...args),
  notice: async (...args: Parameters<AssistantPanelClient['notice']>) => (await panelCloud()).notice(...args),
  pending: async (...args: Parameters<AssistantPanelClient['pending']>) => (await panelCloud()).pending(...args),
} as unknown as AssistantPanelClient

/** The App as installed on this phone: its manifest, switch and the record of where it came from (phoneApps.ts). */
export function phoneInstalledApp(extensionId: string): PhoneInstalledApp | null {
  const manifest = installedExtensionsStore.manifestFor(extensionId)
  if (!manifest) return null
  const record = phoneApps.installRecord(extensionId)
  return {
    manifest,
    origin: record?.origin ?? installedExtensionsStore.origins[extensionId],
    marketSource: record?.marketSource ?? null,
    manifestDigest: record?.manifestDigest ?? null,
    activeVariant: 'upstream',
    enabled: installedExtensionsStore.isEnabled(extensionId),
    mainTabKind: installedExtensionsStore.mainTabOf(extensionId)?.kind ?? null,
  }
}

/** The ports the binding host uses on a phone: this page's own sign-in, clients and stores. */
export function phoneBindingPorts(files: ReturnType<typeof createAppFiles>): PhoneBindingPorts {
  return {
    account() {
      const token = getRendererAccessToken()
      const ownerId = token ? userIdFromSupabaseAccessToken(token) : null
      return token && ownerId ? { token, ownerId } : null
    },
    installed: phoneInstalledApp,
    async personalAssistant(_token, ownerId) {
      const { data, error } = await identityDb.from('agent_provisions').select(PERSONAL_ASSISTANT_SELECT)
        .eq('owner_user_id', ownerId).eq('member_key', 'assistant').limit(32).abortSignal(AbortSignal.timeout(5000))
      if (error) throw failed('Could not verify the personal assistant')
      type Identity = { owner_user_id?: unknown; removed_at?: unknown }
      type Row = Omit<AssistantProvisionRow, 'agent'> & { dm_chat_id?: unknown; agent: Identity | Identity[] | null }
      const rows = (data ?? []) as Row[]
      let pick: ReturnType<typeof pickAssistant>
      try {
        pick = pickAssistant(rows as AssistantProvisionRow[])
      } catch {
        throw failed('Could not verify the personal assistant')
      }
      if (!pick) return null
      const row = rows.find((candidate) => {
        const agent = Array.isArray(candidate.agent) ? candidate.agent.length === 1 ? candidate.agent[0] : null : candidate.agent
        return candidate.agent_user_id === pick.agentId && candidate.member_key === 'assistant' && typeof candidate.dm_chat_id === 'string'
          && ['ready', 'completed'].includes(String(candidate.phase)) && agent?.owner_user_id === ownerId && agent.removed_at === null
      })
      return row ? { agentId: pick.agentId, chatId: row.dm_chat_id as string, deviceId: pick.deviceId } : null
    },
    async conversation(_token, chatId) {
      const [chat, members] = await Promise.all([
        chatDb.from('chats').select('kind').eq('id', chatId).maybeSingle(),
        chatDb.from('active_members').select('user_id').eq('chat_id', chatId),
      ])
      if (chat.error || members.error) throw failed('Could not verify the bound conversation')
      return {
        kind: (chat.data as { kind?: string } | null)?.kind ?? null,
        members: ((members.data ?? []) as { user_id: string }[]).map((row) => row.user_id),
      }
    },
    files: {
      list: (chatId, folder) => files.groupFiles(chatId, folder === undefined ? {} : { folder }),
      read: (chatId, path, maxBytes) => files.readAtPath(chatId, path, maxBytes),
      resourceChat: (chatId) => files.resourceChat(chatId),
    },
    async draft(chatId, text) {
      // The one way a draft reaches a chat's composer on this page (MainLayout): the assistant's chat comes up in its layer.
      composeChatDraft({ chatId, text })
    },
    async renameAssistant(agentId, name) {
      const actions = phoneAssistantLayer.actions()
      if (!actions) throw failed('The assistant is not open on this phone now: try again in a moment')
      await actions.rename(agentId, name)
    },
    // The phone's own picker inside the person's gesture, as `appFiles` uploads pick (phoneAppHost.ts). Cancelled: null.
    pickFiles: () => new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.addEventListener('cancel', () => resolve(null), { once: true })
      input.addEventListener('change', () => {
        const picked = [...(input.files ?? [])]
        resolve(picked.length === 0 ? null : picked.map((file) => ({
          name: file.name, size: file.size, contentType: file.type, read: async () => new Uint8Array(await file.arrayBuffer()),
        })))
      }, { once: true })
      input.click()
    }),
    async confirmRemoval(question) {
      const actions = phoneAssistantLayer.actions()
      if (!actions) throw failed('The assistant is not open on this phone now: try again in a moment')
      return actions.confirmRemoval(question)
    },
    panel: {
      client: lazyPanelClient,
      snapshot: (_ownerId, agentId) => withAssistantPanelReadDeadline(() => lazyPanelClient.snapshot(agentId)),
      resource: (_ownerId, agentId, domain, key) => withAssistantPanelReadDeadline(() => lazyPanelClient.resource(agentId, domain, key)),
      commit: (_ownerId, agentId, change) => lazyPanelClient.commit(agentId, change),
      readBody: (item, access) => readAssistantPanelBody(item, { ...access, accountId: () => phoneAccountId() }),
      uploadBody: (access) => uploadAssistantPanelBody({ ...access, accountId: () => phoneAccountId() }),
      async discard(_token, ownerId, itemId) {
        await Promise.resolve(chatDb.rpc('workspace_delete_as', { p_item_id: itemId, p_as_user_id: ownerId })).catch(() => undefined)
      },
      subscribe: (ownerId, onChange) => requireAssistantPanelBridge().subscribeChanges(ownerId, () => onChange()),
    },
    layer: phoneAssistantLayer,
    randomUUID: () => crypto.randomUUID(),
    async sha256(bytes) {
      const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    },
  }
}

function phoneAccountId(): string | null {
  const token = getRendererAccessToken()
  return token ? userIdFromSupabaseAccessToken(token) : null
}
