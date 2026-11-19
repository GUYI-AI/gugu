import { AssistantCustomizeCard } from '../assistant/AssistantCustomizeCard'
import { useVoiceNoteHandler } from '../assistant/useVoiceNoteHandler'
import '../assistant/assistant-onboarding.css'
import { rendererLogger } from '../../lib/log'
import { useCustomizeCardOffered } from '../../lib/assistantSetupState'
import { rpc } from '@/session/renderer/lib/ipc'
import { IdeasEntry } from '@/session/renderer/features/assistant/assistant-ideas'
import { useIdeasEntryHidden } from '../../lib/assistantIdeas'
import type { ComposerChip } from './appComposerActions'

const log = rendererLogger('app-composer-row')

/**
 * The row above the composer of the account's own assistant chat beside its App, as the built-in page's
 * (AssistantComposerEntries):
 * - left, the host's 「自定义<name>」 hint: offered once after the assistant is set up (`offerCustomizeCard`), gone once opened
 *   or dismissed. The same record on this computer as the built-in page's, so a hint dismissed there stays gone. Opened, the
 *   App's page hears `customize` through main (app-composer-actions.ts `customizeOpenedBeside`), its panel expanded.
 * - right, the App's capsule (its `chip` entry, run as in the 「+」) in the built-in 「灵感」 capsule (IdeasEntry): hidden while a
 *   voice note records, and where the person hid the built-in's on this computer (the same record, by assistant).
 * Neither: no row.
 */
export function AppComposerRow({ ownerId, extensionId, assistant, chip }: {
  ownerId: string; extensionId: string; assistant: { id: string; name: string }; chip: ComposerChip | null
}) {
  const offered = useCustomizeCardOffered(ownerId)
  const chipHidden = useIdeasEntryHidden(assistant.id)
  const { recording } = useVoiceNoteHandler()
  const capsule = chip && !chipHidden && !recording ? chip : null
  if (!offered && !capsule) return null
  const openCustomize = () => {
    void rpc.extensions.conversationCustomizeOpened({ ownerId, extensionId }).then((result) => {
      if (!result.success) throw new Error(result.error)
      if (!result.data.told) log.warn({}, 'No page of the App heard the customize hint')
    }).catch((error: unknown) => log.warn({ error: String(error) }, 'The customize hint could not reach the App'))
  }
  return (
    <div className="ta-composer-entries" data-testid="app-composer-entries">
      {offered ? <AssistantCustomizeCard ownerUserId={ownerId} name={assistant.name} onOpen={openCustomize} /> : null}
      {/* The built-in capsule itself, carrying the App's entry (it hides itself on the same two conditions). */}
      {capsule ? <IdeasEntry assistantId={assistant.id} busy={recording} onOpen={capsule.onSelect} label={capsule.label} icon={capsule.icon} /> : null}
    </div>
  )
}
