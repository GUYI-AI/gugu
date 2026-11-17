import { useState } from 'react'
import type { ComponentProps } from 'react'
import type { SessionOptionDimension } from '@gugu/session-core/session-record/contract'
import type { SessionpageSessionOptionsWithMenu } from '@main/core/session-timeline/session-model-menu'
import { conversationOptionClient } from '../assistant/assistantTimelineClient'
import { sessionModelView } from '@/mobile/agent-watch/session-model-menu'
import { localizeEffortOptions } from '@renderer/features/sessions/session-config/effort-options'
import { localizePermissionModeOptions, selectedPermissionModeId } from '@renderer/features/sessions/acp/permission-mode-options'
import { SessionReloadConfirm } from '@renderer/features/sessions/session-reload-confirm'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { AgentConversationComposer } from '@renderer/lib/chat/agent-conversation-view'
import { messageForUser } from '@/lib/userFacingError'
import { refreshFailure, replica, useReplica } from '@/lib/replica'

export type ConversationTarget = { deviceId: string; sessionId: string; local: boolean; phoneHost?: boolean; /** false while that machine is away: nothing to ask; asked again once it is back. */ reachable?: boolean }

/** A conversation's model / effort / permission options as its host answers; no push, read on every open (`fresh: 0`). */
const conversationOptions = replica({
  name: 'conversationOptions',
  scope: 'account',
  networkMode: (_deviceId: string, _sessionId: string, local: boolean) => (local ? 'always' : 'online'),
  read: (_owner: string, deviceId: string, sessionId: string, local: boolean, phoneHost: boolean): Promise<SessionpageSessionOptionsWithMenu> =>
    conversationOptionClient({ deviceId, sessionId, local, phoneHost }).read(),
  fresh: 0,
})

/** Adapts the host facts through the project page's model, effort and permission assemblers. */
export function useConversationOptions(target: ConversationTarget | null, agentName: string) {
  const deviceId = target?.deviceId, sessionId = target?.sessionId, local = target?.local, phoneHost = target?.phoneHost, reachable = target?.reachable !== false
  // While that machine is away there is nothing to ask: unknown, read once it is back.
  const args: [string, string, boolean, boolean] | null = deviceId && sessionId && local !== undefined && reachable ? [deviceId, sessionId, local, phoneHost === true] : null
  const reading = useReplica(conversationOptions, args)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [restart, setRestart] = useState<{ modelId: string; label: string; source: 'platform' | 'own' } | null>(null)
  const options = reading.state === 'value' ? reading.value : null
  // Unread, or read before and its read again failing (the options read before stay drawn): said in the composer notice.
  const readFailure = refreshFailure(reading)
  const readError = readFailure ? messageForUser(readFailure) : null
  const write = async (send: () => Promise<SessionpageSessionOptionsWithMenu>) => {
    if (!args) return false
    const entry = conversationOptions.at(...args)
    setPending(true)
    try { entry.set(await send()); setWriteError(null); return true }
    catch (cause) { setWriteError(messageForUser(cause)); return false }
    finally { setPending(false) }
  }
  const pick = async (dimension: SessionOptionDimension, value: string) => {
    if (!target || options?.[dimension]?.selected === value) return
    await write(() => conversationOptionClient(target).set(dimension, value))
  }
  const model = options?.modelMenu && options.model ? sessionModelView(options.modelMenu, options.model) : null
  const permissions = options?.mode ? Object.fromEntries(options.mode.available.map(item => [item.id, { name: item.name, description: item.description }])) : null
  const props: Partial<ComponentProps<typeof AgentConversationComposer>> = {
    modelOptions: model ? Object.fromEntries(model.groups.flatMap(group => group.items.map(({ id, ...option }) => [id, option]))) : undefined,
    selectedModel: model?.selectedId,
    onModelChange: id => {
      const plan = model?.plan(id)
      if (plan?.kind === 'hot') void pick('model', plan.wireValue)
      else if (plan?.kind === 'reload') setRestart({ modelId: plan.modelId, label: plan.displayName, source: plan.source === 'platform' ? 'platform' : 'own' })
    },
    effortOptions: localizeEffortOptions(options?.effort ? Object.fromEntries(options.effort.available.map(item => [item.id, { name: item.name, description: item.description }])) : null, translateSessionMessage),
    selectedEffort: options?.effort?.selected ?? undefined,
    onEffortChange: id => { void pick('effort', id) },
    permissionModeOptions: localizePermissionModeOptions(permissions, translateSessionMessage, options?.permissionAgentName ?? options?.modelMenu?.agentName ?? agentName, options?.modeMap),
    selectedPermissionMode: selectedPermissionModeId(options?.mode?.selected ?? undefined, permissions, options?.modeMap),
    onPermissionModeChange: id => { void pick('mode', id) },
    ...(writeError ? { notice: { variant: 'error', message: writeError, onDismiss: () => setWriteError(null) } }
      : readError && args ? { notice: { variant: 'error', message: readError, onDismiss: () => { void conversationOptions.refresh(...args) } } } : {}),
  }
  const confirmation = <SessionReloadConfirm open={!!restart} onOpenChange={open => { if (!open) setRestart(null) }}
    reason="model-switch" target={restart?.label ?? ''} isReloading={pending} onConfirm={async () => {
      if (!target || !restart) return
      if (await write(() => conversationOptionClient(target).reload(restart))) setRestart(null)
    }} />
  return { props, confirmation, steers: options?.modelMenu?.steers === true }
}
