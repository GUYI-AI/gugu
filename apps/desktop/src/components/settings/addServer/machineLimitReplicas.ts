import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { currentMachineLimitRefusal, recentMachineLimitRefusal } from '../../../lib/device-labels'
import { replica } from '../../../lib/replica'

/** #6264 The account's refusal of one machine (null = room now); `keep: 0`: a later notice ❌ opens on an old "there is room". */
export const machineLimitCheck = replica({
  name: 'machineLimitCheck',
  scope: 'account',
  keep: 0,
  read: (_owner: string, machineId: string, via: 'ssh' | 'tunnel'): Promise<MachineLimitRefusal | null> =>
    currentMachineLimitRefusal({ machine_id: machineId, via }),
})

export const MACHINE_LIMIT_CHECK_INTERVAL_MS = 5_000

/** #6264 A machine-limit refusal since `sinceIso` (null = none yet), asked while the one-line install waits. */
export const recentMachineLimitRefusals = replica({
  name: 'recentMachineLimitRefusals',
  scope: 'account',
  keep: 0,
  read: (_owner: string, sinceIso: string) => recentMachineLimitRefusal(sinceIso),
  refreshEvery: (refusal) => (refusal ? false : MACHINE_LIMIT_CHECK_INTERVAL_MS),
})
