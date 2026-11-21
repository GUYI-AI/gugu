import { replica } from './replica'
import { dataClient } from './supabase'

// @@@runtime-capability-policy (#647) - the global min_critical_capability lives in the DB.
/** The lowest non-stale host runtime capability: read once per run, kept for the first frame; a failed read is an error (❌ 0). */
export const runtimeCapabilityPolicy = replica({
  name: 'runtimeCapabilityPolicy',
  scope: 'account',
  read: async (): Promise<number> => {
    const { data, error } = await dataClient
      .schema('identity')
      .from('gugu_runtime_capability_policy')
      .select('min_critical_capability')
      .single()
    // The badge is not drawn while the policy is unknown; the failed read is logged with the model.
    if (error || typeof data?.min_critical_capability !== 'number') throw error ?? new Error('min_critical_capability is not a number')
    return data.min_critical_capability
  },
  fresh: Infinity,
  persist: { maxBytes: 128, maxEntries: 1 },
})
