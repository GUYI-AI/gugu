import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { currentMachineLimitRefusal, recentMachineLimitRefusal } from '../../../lib/device-labels'
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

/** How often the one-line install asks, while it waits, whether the account refused the machine. */
export const MACHINE_LIMIT_CHECK_INTERVAL_MS = 5_000

/**
 * #6264 Whether a server was refused by the machine limit since `sinceIso` (when it tried to sign in with the code the
 * one-line install printed): the refusal with the machine's name, or null = none yet. Asked every few seconds while the
 * install waits and nothing was refused; a refusal stops the asking. Held only while the install waits.
 */
export const recentMachineLimitRefusals = replica({
  name: 'recentMachineLimitRefusals',
  scope: 'account',
  keep: 0,
  read: (_owner: string, sinceIso: string) => recentMachineLimitRefusal(sinceIso),
  refreshEvery: (refusal) => (refusal ? false : MACHINE_LIMIT_CHECK_INTERVAL_MS),
})
