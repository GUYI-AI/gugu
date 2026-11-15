import { rendererLogger } from './log'
import { replica } from './replica'
import { dataClient } from './supabase'

// @@@runtime-capability-policy (#647) - the global min_critical_capability lives in the DB.
/**
 * The lowest host runtime capability that is not flagged as stale. One number for everyone: read once per run (no push),
 * kept across restarts so the badge decision is there on the first frame. A failed read is an error reading (❌ 0, which
 * would hide the badge as if the policy said so).
 */
export const runtimeCapabilityPolicy = replica({
  name: 'runtimeCapabilityPolicy',
  scope: 'account',
  read: async (): Promise<number> => {
    const { data, error } = await dataClient
      .schema('identity')
      .from('gugu_runtime_capability_policy')
      .select('min_critical_capability')
      .single()
    if (error || typeof data?.min_critical_capability !== 'number') {
      const failure = error ?? new Error('min_critical_capability is not a number')
      // The badge is not drawn while the policy is unknown; say why it is missing.
      rendererLogger('runtime-capability-policy').warn({ error: failure }, 'could not read the runtime capability policy; no stale-host badge this run')
      throw failure
    }
    return data.min_critical_capability
  },
  fresh: Infinity,
  persist: { maxBytes: 128, maxEntries: 1 },
})
