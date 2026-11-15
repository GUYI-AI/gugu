import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '@/i18n/format'
import type { ConnectionState } from './connectionState'
import './connection-status.css'

const WORD_KEY = {
  online: 'connection.online',
  connecting: 'connection.connecting',
  device_offline: 'connection.deviceOffline',
} as const satisfies Record<ConnectionState, string>

/**
 * The connection state, drawn in a header's subtitle slot (design v1, owner-approved 2026-11-08): a 12px glyph and
 * one explicit word. ❌ background, border, its own row — it is a subtitle, not a banner.
 *
 * - online: solid live-blue dot.
 * - connecting: a whole live-blue ring that breathes (opacity). Distinct from an agent's 「工作中」, which is an orange
 *   ring with a gap that rotates — different color, shape and motion.
 * - device_offline: muted grey dot; 「最后在线 …」 follows on the same line only here, and only with a known time.
 *
 * In a narrow header the trailing detail (`subject`, last seen, reason) truncates first; the state word never does.
 */
export function ConnectionStatus({
  state,
  lastSeenAt,
  subject,
  detail,
  testId = 'connection-status',
}: {
  state: ConnectionState
  /** `Device.last_seen_at`; shown only when `state` is `device_offline`. Missing → omitted. */
  lastSeenAt?: string | null
  /** Whose state this is when the header is not already about that machine (e.g. a file kept on 「d22」). */
  subject?: string | null
  /** Why, when known and not a time (a cloud computer's wake failure reason). Replaces the last-seen time. */
  detail?: string | null
  testId?: string
}) {
  const { t } = useTranslation('common')
  const seen = state === 'device_offline' && !detail && lastSeenAt ? formatRelativeTime(lastSeenAt) : null
  const trailing = state === 'online' ? null : detail ?? (seen ? t('connection.lastSeen', { time: seen }) : null)
  return (
    <span className="gg-conn-status" role="status" data-state={state} data-testid={testId}>
      <span className="gg-conn-glyph" data-state={state} aria-hidden="true"><span className="gg-conn-glyph-inner" /></span>
      {subject ? <span className="gg-conn-subject" title={subject}>{subject}</span> : null}
      {subject ? <span className="gg-conn-sep" aria-hidden="true">·</span> : null}
      <span className="gg-conn-word">{t(WORD_KEY[state])}</span>
      {trailing ? <span className="gg-conn-sep" aria-hidden="true">·</span> : null}
      {trailing ? <span className="gg-conn-detail" title={trailing} data-testid={`${testId}-detail`}>{trailing}</span> : null}
    </span>
  )
}
