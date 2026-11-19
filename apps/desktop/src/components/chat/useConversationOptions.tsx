import { withAutoReviewHint, type ReviewCostSource } from '@renderer/features/sessions/acp/auto-review-permission-hint'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
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
import { fastModeValue } from '@renderer/features/sessions/session-config/fast-mode'
import { renderFastModeHint } from '@renderer/features/sessions/session-config/fast-mode-hint'

export type ConversationTarget = { deviceId: string; sessionId: string; local: boolean; phoneHost?: boolean; /** false while that machine is away: nothing to ask; asked again once it is back. */ reachable?: boolean }

/** Adapts the host facts through the project page's model, effort and permission assemblers. */
export function useConversationOptions(target: ConversationTarget | null, agentName: string, mobile = false) {
  const { t } = useTranslation('main')
  const deviceId = target?.deviceId, sessionId = target?.sessionId, local = target?.local, phoneHost = target?.phoneHost, reachable = target?.reachable !== false
  const key = target ? `${deviceId}/${sessionId}/${local}/${phoneHost}` : ''
  const scopeRef = useRef({ key })
  if (scopeRef.current.key !== key) scopeRef.current = { key }
  const scope = scopeRef.current
  const readVersion = useRef(0)
  const invalidateReads = useCallback(() => { readVersion.current++ }, [])
  const [read, setRead] = useState<{ key: string; options: SessionpageSessionOptionsWithMenu } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingScope, setPendingScope] = useState<typeof scope | null>(null)
  const pending = pendingScope === scope
  const fastWrite = useRef<typeof scope | null>(null)
  const [pendingFastScope, setPendingFastScope] = useState<typeof scope | null>(null)
  const fastModePending = pendingFastScope === scope
  const [restart, setRestart] = useState<{ modelId: string; label: string; source: 'platform' | 'own' } | null>(null)
  const options = read?.key === key ? read.options : null
  const readOptions = useCallback((includeOwnModelCatalog?: true) => {
    if (!deviceId || !sessionId || local === undefined || !reachable) return
    const version = ++readVersion.current
    const current = () => readVersion.current === version && scopeRef.current === scope
    void conversationOptionClient({ deviceId, sessionId, local, phoneHost }).read(includeOwnModelCatalog).then(options => {
      if (current()) { setRead({ key, options }); setError(null) }
    }, cause => { if (current()) setError(messageForUser(cause)) })
  }, [key, deviceId, sessionId, local, phoneHost, reachable, scope])
  useEffect(() => {
    setError(null)
    readOptions()
    return invalidateReads
  }, [readOptions, invalidateReads])
  const pick = async (dimension: SessionOptionDimension, value: string) => {
    if (!target || options?.[dimension]?.selected === value) return
    if (dimension === 'fast') {
      if (fastWrite.current === scope) return
      fastWrite.current = scope
      setPendingFastScope(scope)
    }
    invalidateReads()
    setPendingScope(scope)
    try {
      const updated = await conversationOptionClient(target).set(dimension, value)
      if (scopeRef.current === scope) { setRead({ key, options: updated }); setError(null) }
    }
    catch (cause) { if (scopeRef.current === scope) setError(messageForUser(cause)) }
    finally {
      if (dimension === 'fast' && fastWrite.current === scope) {
        fastWrite.current = null
        setPendingFastScope(null)
      }
      setPendingScope(current => current === scope ? null : current)
    }
  }
  const model = options?.modelMenu && options.model ? sessionModelView(options.modelMenu, options.model) : null
  const permissions = options?.mode ? Object.fromEntries(options.mode.available.map(item => [item.id, { name: item.name, description: item.description, disabled: item.disabled, reviewByHaiku: item.reviewByHaiku }])) : null
  const reviewAuth = options?.modelMenu?.ownAuth?.status
  const reviewCostSource: ReviewCostSource = options?.modelMenu?.conversationSelection ? 'platform'
    : options?.modelMenu?.customModel ? 'api-key'
    : options?.modelMenu?.conversationSelection === null && reviewAuth?.kind === 'authenticated' ? reviewAuth.credentialKind ?? 'unknown' : 'unknown'
  const props: Partial<ComponentProps<typeof AgentConversationComposer>> = {
    modelOptions: model ? Object.fromEntries(model.groups.flatMap(group => group.items.map(({ id, ...option }) => [id, option]))) : undefined,
    onModelMenuOpen: () => { if (!pending && !fastModePending) readOptions(true) },
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
    renderFastModeHint,
    permissionModeOptions: withAutoReviewHint(localizePermissionModeOptions(permissions, translateSessionMessage, options?.permissionAgentName ?? options?.modelMenu?.agentName ?? agentName, options?.modeMap,
      mobile ? tier => t(`agentWatch.create.permission.${tier}.name`) : undefined), options?.modelMenu?.providerId, reviewCostSource, options?.modeMap),
    selectedPermissionMode: selectedPermissionModeId(options?.mode?.selected ?? undefined, permissions, options?.modeMap),
    onPermissionModeChange: id => { void pick('mode', id) },
    ...(error ? { notice: { variant: 'error', message: error, onDismiss: () => setError(null) } } : {}),
  }
  const confirmation = <SessionReloadConfirm open={!!restart} onOpenChange={open => { if (!open) setRestart(null) }}
    reason="model-switch" target={restart?.label ?? ''} isReloading={pending} onConfirm={async () => {
      if (!target || !restart) return
      invalidateReads()
      setPendingScope(scope)
      try { setRead({ key, options: await conversationOptionClient(target).reload(restart) }); setRestart(null); setError(null) }
      catch (cause) { setError(messageForUser(cause)) }
      finally { setPendingScope(current => current === scope ? null : current) }
    }} />
  return { props, confirmation, fastModePending, steers: options?.modelMenu?.steers === true }
}
