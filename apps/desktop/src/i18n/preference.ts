import { devicePreferences } from '../lib/devicePreferences'
import type { LocalePreference } from './locale'
import { applyLocalePreference, getLocaleSnapshot } from './runtime'

/**
 * The language preference in this shell's device store (lib/devicePreferences.ts): set here (applied to the document
 * first, then stored), and followed when it changes elsewhere (another window, another tab of the web page, its first
 * read after a failed handover). Kept apart from i18n/runtime.ts so that module stays out of the store's import chain.
 */
export function setLocalePreference(next: LocalePreference): void {
  // Applied first: the follower below then finds its own write already in place.
  applyLocalePreference(next, true)
  devicePreferences.write('locale', next)
}

devicePreferences.subscribe(() => {
  const reading = devicePreferences.read('locale')
  if (reading.state !== 'value' || reading.value === getLocaleSnapshot().preference) return
  applyLocalePreference(reading.value, false)
})
