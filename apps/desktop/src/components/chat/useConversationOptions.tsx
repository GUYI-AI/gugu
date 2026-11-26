import { withAutoReviewHint, type ReviewCostSource } from '@renderer/features/sessions/acp/auto-review-permission-hint'
import { useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionOptionDimension } from '@gugu/session-core/session-record/contract'
import type { SessionpageSessionOptionsWithMenu } from '@main/core/session-timeline/session-model-menu'
import { conversationOptionClient } from '../assistant/assistantTimelineClient'
import { sessionModelView } from '@/components/session-watch/session-model-menu'
import { localizeEffortOptions } from '@renderer/features/sessions/session-config/effort-options'
import { localizePermissionModeOptions, selectedPermissionModeId } from '@renderer/features/sessions/acp/permission-mode-options'
import { SessionReloadConfirm } from '@renderer/features/sessions/session-reload-confirm'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { AgentConversationComposer } from '@renderer/lib/chat/agent-conversation-view'
import { messageForUser } from '@/lib/userFacingError'
import { rendererLogger } from '@/lib/log'
import { refreshFailure, replica, useReplica } from '@/lib/replica'
import { fastModeValue, fastTokenMultiplier } from '@renderer/features/sessions/session-config/fast-mode'
import { fastModeHint } from '@renderer/features/sessions/session-config/fast-mode-hint'
import { useAgent } from '@renderer/lib/stores/use-agents'

const log = rendererLogger('chat/conversation-options')

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

/** Who pays for the auto-review model: the platform, an API key, or the signed-in account's own kind; 'unknown' says it is not known. */
function reviewCostSourceOf(menu: SessionpageSessionOptionsWithMenu['modelMenu'] | undefined): ReviewCostSource {
  if (menu?.conversationSelection) return 'platform'
  if (menu?.customModel) return 'api-key'
  const auth = menu?.ownAuth?.status
  return menu?.conversationSelection === null && auth?.kind === 'authenticated' ? auth.credentialKind ?? 'unknown' : 'unknown'
}

/** Adapts the host facts through the project page's model, effort and permission assemblers. */
export function useConversationOptions(target: ConversationTarget | null, agentName: string, mobile = false) {
  const { t } = useTranslation('main')
  const deviceId = target?.deviceId, sessionId = target?.sessionId, local = target?.local, phoneHost = target?.phoneHost, reachable = target?.reachable !== false
  // While that machine is away there is nothing to ask: unknown, read once it is back.
  const args: [string, string, boolean, boolean] | null = deviceId && sessionId && local !== undefined && reachable ? [deviceId, sessionId, local, phoneHost === true] : null
  const reading = useReplica(conversationOptions, args)
  const key = target ? `${deviceId}/${sessionId}/${local}/${phoneHost}` : ''
  const scopeRef = useRef({ key })
  if (scopeRef.current.key !== key) scopeRef.current = { key }
  const scope = scopeRef.current
  const [writeFailure, setWriteFailure] = useState<{ scope: typeof scope; message: string } | null>(null)
  const writeError = writeFailure?.scope === scope ? writeFailure.message : null
  const [pendingScope, setPendingScope] = useState<typeof scope | null>(null)
  const pending = pendingScope === scope
  const fastWrite = useRef<typeof scope | null>(null)
  const [pendingFastScope, setPendingFastScope] = useState<typeof scope | null>(null)
  const fastModePending = pendingFastScope === scope
  const [restart, setRestart] = useState<{ modelId: string; label: string; source: 'platform' | 'own' } | null>(null)
  const options = reading.state === 'value' ? reading.value : null
  // Unread, or read before and its read again failing (the options read before stay drawn): said in the composer notice.
  const readFailure = refreshFailure(reading)
  const readError = readFailure ? messageForUser(readFailure) : null
  const write = async (send: () => Promise<SessionpageSessionOptionsWithMenu>) => {
    if (!args) return false
    const entry = conversationOptions.at(...args)
    setPendingScope(scope)
    try {
      entry.set(await send())
      if (scopeRef.current !== scope) return false
      setWriteFailure(null)
      return true
    } catch (cause) {
      if (scopeRef.current === scope) setWriteFailure({ scope, message: messageForUser(cause) })
      return false
    } finally { setPendingScope(current => current === scope ? null : current) }
  }
  const pick = async (dimension: SessionOptionDimension, value: string) => {
    if (!target || options?.[dimension]?.selected === value) return
    // One fast-mode change at a time: a second click while the first is on its way is not a second write.
    if (dimension !== 'fast') { await write(() => conversationOptionClient(target).set(dimension, value)); return }
    if (fastWrite.current === scope) return
    fastWrite.current = scope
    setPendingFastScope(scope)
    try { await write(() => conversationOptionClient(target).set(dimension, value)) }
    finally {
      if (fastWrite.current === scope) {
        fastWrite.current = null
        setPendingFastScope(null)
      }
    }
  }
  // Fast's cost comes from the running provider's declaration (the host already filtered Fast to what it offers).
  const provider = useAgent(options?.fast ? options.modelMenu?.providerId : null)
  const model = options?.modelMenu && options.model ? sessionModelView(options.modelMenu, options.model) : null
  const permissions = options?.mode ? Object.fromEntries(options.mode.available.map(item => [item.id, { name: item.name, description: item.description, disabled: item.disabled, reviewByHaiku: item.reviewByHaiku }])) : null
  const reviewCostSource = reviewCostSourceOf(options?.modelMenu)
  const props: Partial<ComponentProps<typeof AgentConversationComposer>> = {
    modelOptions: model ? Object.fromEntries(model.groups.flatMap(group => group.items.map(({ id, ...option }) => [id, option]))) : undefined,
    // Opening the model menu reads the options again with this agent's own model catalog (asked only then: it is slow).
    onModelMenuOpen: () => {
      if (!target || !args || pending || fastModePending) return
      const entry = conversationOptions.at(...args)
      void conversationOptionClient(target).read(true).then(options => entry.set(options), cause => log.warn({ error: String(cause) }, 'conversation options with the model catalog unreadable'))
    },
    selectedModel: model?.selectedId,
    onModelChange: id => {
      const plan = model?.plan(id)
      if (plan?.kind === 'hot') void pick('model', plan.wireValue)
      else if (plan?.kind === 'reload') setRestart({ modelId: plan.modelId, label: plan.displayName, source: plan.source === 'platform' ? 'platform' : 'own' })
    },
    effortOptions: localizeEffortOptions(options?.effort ? Object.fromEntries(options.effort.available.map(item => [item.id, { name: item.name, description: item.description, disabled: item.disabled, reviewByHaiku: item.reviewByHaiku }])) : null, translateSessionMessage, mobile ? 'known' : 'all-or-none'),
    selectedEffort: options?.effort?.selected ?? undefined,
    onEffortChange: id => { void pick('effort', id) },
    // The host filters this group by the current model's acknowledged native capability.
    fastMode: fastModeValue(options?.fast),
    onFastModeChange: enabled => { void pick('fast', enabled ? 'on' : 'off') },
    renderFastModeHint: fastModeHint(fastTokenMultiplier(provider.state === 'value' ? provider.value?.capabilities : null, false)),
    permissionModeOptions: withAutoReviewHint(localizePermissionModeOptions(permissions, translateSessionMessage, options?.permissionAgentName ?? options?.modelMenu?.agentName ?? agentName, options?.modeMap,
      mobile ? tier => t(`agentWatch.create.permission.${tier}.name`) : undefined), options?.modelMenu?.providerId, reviewCostSource, options?.modeMap),
    selectedPermissionMode: selectedPermissionModeId(options?.mode?.selected ?? undefined, permissions, options?.modeMap),
    onPermissionModeChange: id => { void pick('mode', id) },
    ...(writeError ? { notice: { variant: 'error', message: writeError, onDismiss: () => setWriteFailure(null) } }
      : readError && args ? { notice: { variant: 'error', message: readError, onDismiss: () => { void conversationOptions.refresh(...args) } } } : {}),
  }
  const confirmation = <SessionReloadConfirm open={!!restart} onOpenChange={open => { if (!open) setRestart(null) }}
    reason="model-switch" target={restart?.label ?? ''} isReloading={pending} onConfirm={async () => {
      if (!target || !restart) return
      if (await write(() => conversationOptionClient(target).reload(restart))) setRestart(null)
    }} />
  return { props, confirmation, fastModePending, steers: options?.modelMenu?.steers === true }
}
