import type { SessionpageSessionCreateModels } from '@gugu/session-core/session-record/contract'
import { fastModeValue } from '@renderer/features/sessions/session-config/fast-mode'
import { localizeEffortOptions } from '@renderer/features/sessions/session-config/effort-options'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { CreateSelection } from './create-session-form'

/** Snapshot identity prevents a previous device/provider/model's Fast from leaking into the next choice. */
export function creationThinking(models: SessionpageSessionCreateModels | null, selection: CreateSelection & { fastMode?: boolean }) {
  const current = models?.harness === selection.harness ? models : null
  const fast = current?.fast
  return {
    effortOptions: localizeEffortOptions(current ? Object.fromEntries(current.efforts.map(option => [option.id, {
      name: option.name, ...(option.description ? { description: option.description } : {}),
    }])) : null, translateSessionMessage, 'known'),
    selectedEffort: selection.effort ?? undefined,
    defaultEffort: current?.selectedEffort ?? undefined,
    fastMode: selection.model && fast?.model === selection.model && fastModeValue(fast) !== undefined
      ? selection.fastMode === true : undefined,
  }
}
