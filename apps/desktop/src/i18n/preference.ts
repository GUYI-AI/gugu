import { devicePreferences } from '../lib/devicePreferences'
import type { LocalePreference } from './locale'
import { applyLocalePreference, getLocaleSnapshot } from './runtime'

/** The language preference in this shell's device store: set here, followed when it changes elsewhere. Apart from runtime.ts (import chain). */
export function setLocalePreference(next: LocalePreference): void {
  applyLocalePreference(next, true)
  devicePreferences.write('locale', next)
}

devicePreferences.subscribe(() => {
  const reading = devicePreferences.read('locale')
  if (reading.state !== 'value' || reading.value === getLocaleSnapshot().preference) return
  applyLocalePreference(reading.value, false)
})
