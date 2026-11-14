import type { MessageReferenceTarget } from '@gugu/session-shared/markdown/dialect'
import { fetchInChunks } from '@gugu/core/shared/inChunks'
import { chatDb } from './supabase'

/**
 * Only labels, under the viewing account's existing widget RLS; no spec or quoted body. Apart from widgetRegistry: list
 * projections import this, and must not pull in the chat service and its React graph.
 */
export async function widgetReferenceTexts(targets: readonly MessageReferenceTarget[], signal?: AbortSignal, onRead?: () => void) {
  const labels = new Map<string, string>()
  await Promise.all((['widget', 'message'] as const).map(async kind => {
    const ids = [...new Set(targets.flatMap(target => target.kind === kind
      ? [target.kind === 'widget' ? target.widgetId : target.messageId] : []))]
    const column = kind === 'widget' ? 'id' : 'message_id'
    const rows = await fetchInChunks(ids, async chunk => {
      onRead?.()
      let query = chatDb.from('widgets').select('id,chat_id,message_id,text').in(column, chunk)
      if (signal) query = query.abortSignal(signal)
      const { data, error } = await query
      if (error) throw new Error(error.message)
      return (data ?? []) as Array<{ id: string; chat_id: string; message_id: string; text: string }>
    })
    for (const row of rows) labels.set(kind === 'widget' ? `widget:${row.id}` : `message:${row.chat_id}/${row.message_id}`, row.text)
  }))
  return labels
}
