import { readModel } from '@/lib/readModel'
import { machineRpc } from './sessionpage-rpc'
import { loadCreationSkills } from './create-skills'

/** One account-scoped reading per execution device, native harness and project. */
export const creationSkills = readModel({
  name: 'phoneNativeCreationSkills.v1',
  scope: 'account',
  read: (_owner, deviceId: string, harness: string, projectId: string | null) =>
    loadCreationSkills(machineRpc(deviceId).sessionTimeline, harness, projectId),
  fresh: 30_000,
})
