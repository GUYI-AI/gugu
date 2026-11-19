import { reaction } from 'mobx'
import { useEffect, useState } from 'react'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { ASSISTANT_APP_ID, assistantLayerEntry, type AssistantLayerEntry } from '@/session/shared/extensions/assistant-entry'
import type { AppAssistantStatus } from '@/session/shared/extensions/assistant-binding'
import { ASSISTANT_NAME_MAX, isFailureClass, NAME_MAX, isAssistantFace } from '@/session/shared/extensions/assistant-binding'
import { assistantTintHue } from '@/lib/assistantTint'
import { phoneInstalledApp } from '@/components/appSlot/phoneBindingPorts'
import type { PhoneAssistantState } from './usePhoneAssistant'

/** The slot the layer draws the App's main page in: what the binding host believes the layer shows (phoneAssistantLayer). */
export const PHONE_ASSISTANT_LAYER_TAB = 'assistant-layer'

/**
 * The assistant's place on this phone (assistant-entry.ts): the product's assistant App's main page, or the built-in pages.
 * Read from the App store as it is now, again on every change of it; built-in until the store has been read.
 */
export function usePhoneAssistantEntry(): AssistantLayerEntry {
  const [entry, setEntry] = useState<AssistantLayerEntry>(() => entryNow())
  useEffect(() => reaction(
    () => JSON.stringify(entryNow()),
    (next) => setEntry(JSON.parse(next) as AssistantLayerEntry),
    { fireImmediately: true },
  ), [])
  return entry
}

function entryNow(): AssistantLayerEntry {
  if (!installedExtensionsStore.isLoaded) return { entry: 'built-in', reason: 'the Apps on this phone are not read yet' }
  // Read for the reaction: what it depends on (manifests, switches, origins) is all in the store.
  void installedExtensionsStore.manifests.length
  void installedExtensionsStore.disabled.length
  return assistantLayerEntry(phoneInstalledApp(ASSISTANT_APP_ID), 'phone')
}

/** 云上的家「在」= 它此刻答得上话(睡着的会自己醒),as the desktop says it (lib/assistantAppHost.ts). */
const CLOUD_ANSWERS = new Set(['awake', 'asleep', 'waking'])

/**
 * The assistant as an App may see it (`AppAssistantStatus`), from what the phone's layer knows (usePhoneAssistant): found or
 * why not, its name and face, where it lives — a phone is never its home, so a computer is always another one — and
 * whether the cloud can have it. Membership is not read on a phone: null (not known), never false. Setup on a phone ends at
 * the home: never a step an App draws.
 */
export function phoneAssistantStatusOf(state: PhoneAssistantState, face: string | null, cloud: { available: boolean; state: string | null; loadError: unknown }, ownerName: string | null = null): AppAssistantStatus {
  const stage = state.stage.stage
  const assistant: AppAssistantStatus['assistant'] = state.assistant ? 'found'
    : stage === 'identity' ? (state.stage as { state: 'loading' | 'unreadable' }).state
    : stage === 'cloud-loading' ? 'loading'
    : 'none'
  const home = state.home
  const found = state.assistant
  // Its bird's body hue, as the desktop says it (assistantTint.ts); a photo face has none.
  const tint = found ? assistantTintHue(found.id, found.avatar) ?? null : null
  return {
    assistant,
    name: found ? found.display_name.slice(0, NAME_MAX) : null,
    avatar: found && face && isAssistantFace(face) ? face : null,
    tint: tint !== null && Number.isFinite(tint) && tint >= 0 && tint <= 360 ? tint : null,
    home: !found || !home ? null
      : home.kind === 'cloud' ? { kind: 'cloud', online: CLOUD_ANSWERS.has(cloud.state ?? ''), label: null }
      : { kind: home.hostKind === 'server' ? 'server' : 'other-computer', online: home.online, label: textOrNull(home.label) },
    setup: null,
    preparing: false,
    cloudAvailable: cloud.available,
    member: null,
    loadError: cloud.loadError ? (isFailureClass(String(cloud.loadError)) ? String(cloud.loadError) : 'failed') : null,
    ownerName: textOrNull(ownerName),
    // The 资料 rows' numbers come from the layer's own read (PhoneAssistantCounts.tsx, merged by phoneAssistantLayer); the
    // connect list is a computer's setup step: not known here (null), never empty.
    counts: null,
    connectors: null,
    nameMax: ASSISTANT_NAME_MAX,
  }
}
const textOrNull = (text: string | null | undefined) => text?.trim().slice(0, NAME_MAX) || null
