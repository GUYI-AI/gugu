import type { UpcomingMeeting } from '@gugu/core/shared/voiceNotes'
import { replica } from './replica'
import { invokeOnMachine } from '../session/renderer/lib/ipc'
import { VOICE_NOTE_MEETINGS_CHANNEL, type VoiceNoteMeetingsResult } from '../session/shared/core/voice-notes'

/** This computer's calendar. `missing` = none here (a value); read every 30 s while shown and on focus. */
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
  // As fresh as its poll: a surface opening within it is no reason to read again.
  fresh: 30_000,
  refreshOnFocus: true,
})
