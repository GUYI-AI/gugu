import type { UpcomingMeeting } from '@gugu/core/shared/voiceNotes'
import { replica } from './replica'
import { invokeOnMachine } from '../session/renderer/lib/ipc'
import { VOICE_NOTE_MEETINGS_CHANNEL, type VoiceNoteMeetingsResult } from '../session/shared/core/voice-notes'

/**
 * This computer's calendar as the meeting reminder and its setting read it (one read of `VOICE_NOTE_MEETINGS_CHANNEL`,
 * device scope). `missing` = no calendar to read here (not connected / not supported / no OS permission): a true value.
 * Any other failure is a failed read (❌ taken for "connected"). `meetings` is not carried across restarts (titles and
 * times of meetings): a restored value has none, and its readers take that as "not known yet" (the reminder waits for the
 * read; the setting only needs the status). No push: read while shown every 30 s (a reminder lands 1 min before a meeting)
 * and when the window comes back.
 */
export type DeviceMeetings = { status: 'ok' | 'missing'; meetings?: UpcomingMeeting[] }

const MISSING = new Set(['not_granted', 'unsupported', 'os_permission'])

export const deviceMeetings = replica({
  name: 'deviceMeetings',
  scope: 'device',
  read: async (): Promise<DeviceMeetings> => {
    const result = await (invokeOnMachine(null, VOICE_NOTE_MEETINGS_CHANNEL) as Promise<VoiceNoteMeetingsResult>)
    if (result.ok) return { status: 'ok', meetings: result.meetings }
    if (MISSING.has(result.code)) return { status: 'missing' }
    throw new Error(`calendar read failed: ${result.code}`)
  },
  refreshEvery: 30_000,
  refreshOnFocus: true,
  // Only the status (`{"status":"missing"}`, ~70 B with its key): the settings row's first frame.
  persist: { maxBytes: 128, maxEntries: 1, carry: ({ status }: DeviceMeetings): DeviceMeetings => ({ status }) },
})
