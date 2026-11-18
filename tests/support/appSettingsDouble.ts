import { vi } from 'vitest'

/**
 * A `useAppSettingsKey` result for component tests that stub the settings key: `value` read (undefined = not read yet,
 * the reading is unknown). Same shape as the hook (session/renderer/features/settings/use-app-settings-key.tsx).
 */
export function fakeAppSettings<V>(value: V | undefined, overrides: Record<string, unknown> = {}) {
  return {
    settings: value === undefined
      ? { state: 'unknown' as const }
      : { state: 'value' as const, value: { value, defaults: value, overrides: {} }, stale: false, error: null },
    unavailable: false,
    isSaving: false,
    isOverridden: false,
    isFieldOverridden: () => false,
    update: vi.fn(),
    updateAsync: vi.fn(async () => undefined),
    reset: vi.fn(),
    resetField: vi.fn(),
    ...overrides,
  }
}

/** A read value (for stubs of hooks that return a `Reading`). */
export function readValue<V>(value: V) {
  return { state: 'value' as const, value, stale: false, error: null }
}
