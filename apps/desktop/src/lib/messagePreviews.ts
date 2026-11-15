import { messageReferenceBlocks, messageReferencePreview } from '@gugu/session-shared/markdown/dialect'
import { widgetReferenceTexts } from './widgetLabels'
import { rendererLogger } from './log'
// The runtime alone: the i18n index brings React with it, which a list projection must not load.
import { i18n } from '../i18n/runtime'

const log = rendererLogger('chat/previews')

/** Lists, notifications and send acknowledgements share this projection. The
 * server supplies source only for marker-bearing messages; it remains an input
 * hint and never decides which links are reference blocks. */
export async function messagePreviewLines(
  rows: readonly { preview: string | null; source?: string | null }[],
  signal?: AbortSignal,
  onReferenceRead?: () => void,
): Promise<Array<string | null>> {
  const parsed = rows.map(row => {
    const hint = row.source?.toLowerCase()
    return hint?.includes('gugu-chat://') || hint?.includes('gugu-widget://')
      ? messageReferenceBlocks(row.source!) : null
  })
  // Labels are a nicety: one that cannot be read leaves the plain reference line, never a list or a send that fails.
  const labels = await widgetReferenceTexts(parsed.flatMap(row => row?.blocks.map(block => block.target) ?? []), signal, onReferenceRead)
    .catch((error: unknown) => {
      signal?.throwIfAborted()
      log.warn({ error: String(error) }, 'reference labels could not be read')
      return new Map<string, string>()
    })
  signal?.throwIfAborted()
  const words = { quote: i18n.t('message.reference.previewQuote', { ns: 'messaging' }), message: i18n.t('message.reference.previewMessage', { ns: 'messaging' }) }
  return rows.map((row, index) => {
    const source = parsed[index]
    if (!source?.blocks.length) return row.preview
    return messageReferencePreview(source, target => labels.get(target.kind === 'widget'
      ? `widget:${target.widgetId}` : `message:${target.chatId}/${target.messageId}`), words).slice(0, 100)
  })
}
