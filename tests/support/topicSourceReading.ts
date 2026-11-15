import type { Reading } from '../../apps/desktop/src/lib/replica'
import type { TopicSourceState } from '../../apps/desktop/src/lib/topics'

/** A topic source as read (the breadcrumb's input): its preview, gone (null), unreadable, or not read yet ('unknown'). */
export function topicSourceReading(preview: string | null | 'unreadable' | 'unknown'): Reading<TopicSourceState> {
  if (preview === 'unknown') return { state: 'unknown' }
  const value: TopicSourceState = preview === null ? { kind: 'gone' } : preview === 'unreadable' ? { kind: 'unreadable' } : { kind: 'readable', preview }
  return { state: 'value', value, stale: false, error: null }
}
