import type { HarnessCatalogState } from '@main/core/agents/harness-model-catalog'

/** Canonical Fast tier; eligibility still comes from the native current-model option. */
export function codexStartupFastTier(input: {
  enabled: boolean; model?: string | null; credits: boolean; catalog: HarnessCatalogState | null;
}): 'priority' | 'default' {
  if (!input.enabled || input.credits || input.catalog?.kind !== 'ready') return 'default'
  if (input.model && input.catalog.selected !== input.model) return 'default'
  const fast = input.catalog.fastMode
  return fast?.configId === 'fast' && ['on', 'off'].every(id => fast.available.some(option => option.id === id))
    ? 'priority' : 'default'
}
