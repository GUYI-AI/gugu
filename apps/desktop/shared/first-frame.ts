// @@@first-frame — what the renderer needs before its first frame, in one synchronous answer from main (preload asks while
// it loads, as it does for the host's system languages, host-localization.ts). Main answers from its database
// (better-sqlite3 is synchronous):
// - the view state (③: drafts, reading positions, tabs, what is folded), every stored entry, oldest write first;
// - this device's preferences (shared/device-preferences.ts). The request carries what the old localStorage keys still
//   hold (the one-time move); the answer names the keys main settled, and preload deletes exactly those.
import type { DevicePreferences, StoredPreferenceName, StoredPreferenceStrings } from './device-preferences'

export const FIRST_FRAME_CHANNEL = 'first-frame:handover'

export type FirstFrameRequest = { storedPreferences: StoredPreferenceStrings }

/** Each part null when main had none to give (the session page backend is down, or the read failed: said by main). */
export type FirstFrameAnswer = {
  viewState: Record<string, unknown> | null
  devicePreferences: DevicePreferences | null
  settled: StoredPreferenceName[]
}

/** What preload exposes on `window`; its presence is what makes a document the desktop shell. */
export const FIRST_FRAME_GLOBAL = 'guguFirstFrame'
export type FirstFrameGlobal = Omit<FirstFrameAnswer, 'settled'>
