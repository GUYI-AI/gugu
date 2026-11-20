import { useSyncExternalStore } from 'react'
import type { LocalePreference } from './locale'
import { getLocaleSnapshot, subscribeLocale } from './runtime'
import { setLocalePreference } from '../lib/devicePreferences'

export function useLocale(): ReturnType<typeof getLocaleSnapshot> & {
  setPreference: (preference: LocalePreference) => void
} {
  const state = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot)
  return { ...state, setPreference: setLocalePreference }
}

