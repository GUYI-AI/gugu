import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import { withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'
import { ASSISTANT_BINDING_ARGS, ASSISTANT_BINDING_RPC, pickAssistant } from '@gugu/core/shared/assistantProvision'
import { userIdFromSupabaseAccessToken } from '@gugu/core/cloud/runtimeAuthProvider'
import type { AssistantPanelClient } from '@gugu/core/cloud/assistantPanel'
import { requireAssistantPanelBridge } from '../../lib/assistantPanelBridge'
import { composeChatDraft } from '../../lib/composeDraft'
import { getRendererAccessToken } from '../../lib/sessionPublication'
import { chatDb, identityDb } from '../../lib/supabase'
import { peekInstalledApps, PHONE_HOST } from '../../session/renderer/features/extensions/installed-extensions'
import type { createAppFiles } from '../../session/shared/extensions/app-files-core'
import { phoneApps } from './phoneApps'
import { phoneAssistantLayer } from './phoneAssistantLayer'
import type { PhoneBindingPorts, PhoneInstalledApp } from './phoneAppBindings'

const failed = (message: string) => Object.assign(new Error(message), { code: 'failed' })


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

/** The App as installed on this phone (phoneApps.ts), a one-moment answer. */
export function phoneInstalledApp(extensionId: string): PhoneInstalledApp | null {
  const installed = peekInstalledApps(PHONE_HOST)
  const manifest = installed ? installed.manifestFor(extensionId) : undefined
  if (!installed || !manifest) return null
  const record = phoneApps.installRecord(extensionId)
  return {
    manifest,
    origin: record?.origin ?? installed.origins[extensionId],
    marketSource: record?.marketSource ?? null,
    manifestDigest: record?.manifestDigest ?? null,
    activeVariant: 'upstream',
    enabled: installed.isEnabled(extensionId),
    mainTabKind: installed.mainTabOf(extensionId)?.kind ?? null,
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
    async personalAssistant(_token, _ownerId) {
      const bound = await identityDb.rpc(ASSISTANT_BINDING_RPC, ASSISTANT_BINDING_ARGS).abortSignal(AbortSignal.timeout(5000))
      if (bound.error) throw failed('Could not verify the personal assistant')
      let pick: ReturnType<typeof pickAssistant>
      try {
        pick = pickAssistant(bound.data)
      } catch {
        throw failed('Could not verify the personal assistant')
      }
      if (!pick) return null
      // Its private conversation: the person's DM with that agent (`bound` checks it has no one else in it).
      const dms = await chatDb.from('chats').select('id,members:chat_members!inner(user_id)').eq('kind', 'dm')
        .eq('members.user_id', pick.agentId).limit(2).abortSignal(AbortSignal.timeout(5000))
      if (dms.error) throw failed('Could not verify the personal assistant')
      const rows = (dms.data ?? []) as { id: string }[]
      if (rows.length > 1) throw failed('Could not verify the personal assistant')
      return rows[0] ? { agentId: pick.agentId, chatId: rows[0].id, deviceId: pick.deviceId } : null
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
