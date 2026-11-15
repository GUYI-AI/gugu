import { PREFERENCE_STORAGE_KEYS } from '../../apps/desktop/shared/device-preferences'

// The browser shell's device store is localStorage (lib/devicePreferences.ts): each test file starts on the system language.
localStorage.removeItem(PREFERENCE_STORAGE_KEYS.locale)
