import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { currentMachineLimitRefusal } from '../../../lib/device-labels'
import { replica } from '../../../lib/replica'

/**
 * #6264 Whether the account still refuses one attempted machine (the enforcement RPC's own answer: the refusal with its
 * occupants, or null = there is room now). Read when a refusal notice shows it and again after each removal made from
 * that notice; held only while the notice is shown (a later notice must not open on an old "there is room").
 */
export const machineLimitCheck = replica({
  name: 'machineLimitCheck',
  scope: 'account',
  keep: 0,
  read: (_owner: string, machineId: string, via: 'ssh' | 'tunnel'): Promise<MachineLimitRefusal | null> =>
    currentMachineLimitRefusal({ machine_id: machineId, via }),
})
