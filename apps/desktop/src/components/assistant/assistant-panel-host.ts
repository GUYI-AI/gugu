import { assistantWorkReads } from '@/lib/assistantWorkShell'
import { createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { getRendererSession, observeRendererSession } from '@/lib/sessionPublication'
import { chatDb } from '@/lib/supabase'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '@/lib/realtimeChannel'
import type { AssistantPanelBridge, AssistantPanelWindow } from '@/lib/assistantPanelBridge'
import { assistantPanelCloud, assertAssistantPanelOwner, queueAssistantAppChange } from './assistant-panel-cloud'
import { assistantPanel, assistantPanelReadCache } from './assistant-panel-replica'
import { assistantPanelBodies } from '@/lib/assistantPanelBodies'
import { myAssistant } from '@/lib/myAssistant'

const bridge: AssistantPanelBridge = {
  work: assistantWorkReads,
  accountId: () => getRendererSession()?.user.id ?? null,
  subscribeAccount: listener => observeRendererSession(() => listener()),
  files({ ownerId,assistantId,chatId,deviceId }) {
    assertAssistantPanelOwner(ownerId)
    const access = () => {
      assertAssistantPanelOwner(ownerId)
      const token = getRendererSession()?.access_token
      if (!token) throw new AssistantPanelError('signed-out','PANEL_SIGNED_OUT')
      return { token,chatId,ownerId,accountId: () => getRendererSession()?.user.id ?? null }
    }
    // A read already on its way may have begun before a write (I2): then a read of its own (`reread`), ❌ joining it.
    const cloud = { ...assistantPanelCloud,snapshot: (id: string) => assistantPanel.isFetching(id) ? assistantPanel.reread(id) : assistantPanel.fetch(id) }
    return createAssistantPanelFiles({ ownerId,assistantId,deviceId,cloud,
      cache: assistantPanelReadCache(ownerId,assistantId),
      assertCurrent: () => assertAssistantPanelOwner(ownerId),
      readBody: (item,signal) => readAssistantPanelBody(item,{ ...access(),signal }),
      upload: (name,bytes) => uploadAssistantPanelBody({ ...access(),label: name,bytes }),
      discard: async itemId => {
        assertAssistantPanelOwner(ownerId)
        const { error } = await chatDb.rpc('workspace_delete_as',{ p_item_id: itemId,p_as_user_id: ownerId }).abortSignal(AbortSignal.timeout(10_000))
        assertAssistantPanelOwner(ownerId)
        if (error) throw error
      },
      changed: () => undefined,
    })
  },
  subscribeChanges(ownerId,listener,domain='panel') {
    assertAssistantPanelOwner(ownerId)
    const handle = domain==='work'
      ? subscribePrivateUserEventBus(ownerId,'assistant_work_changed',listener,{onSubscribed:()=>listener()})
      : subscribePrivateUserEventBus(ownerId,'assistant_panel_changed',listener,{onSubscribed:()=>listener()})
    return () => unsubscribePrivateUserEventBus(handle)
  },
  async panelSnapshot(ownerId,assistantId) {
    assertAssistantPanelOwner(ownerId)
    const snapshot = await assistantPanelCloud.snapshot(assistantId)
    assertAssistantPanelOwner(ownerId)
    return snapshot
  },
  queueNotice: queueAssistantAppChange,
}

/** App entry only: install before the embedded session-page bundle mounts. */
export function installAssistantPanelHost(w: Window = window): void {
  void assistantPanelBodies.ready;
  (w as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__ = bridge
}

/** @@@client-state-model - read the panel as soon as the session is restored, so opening it draws on the first frame. */
observeRendererSession(({ event, session }) => {
  if (!session || (event !== 'SIGNED_IN' && event !== 'INITIAL_SESSION')) return
  void myAssistant.fetch().then((mine) => { if (mine.agentId) void assistantPanel.prefetch(mine.agentId) }, () => undefined)
})
