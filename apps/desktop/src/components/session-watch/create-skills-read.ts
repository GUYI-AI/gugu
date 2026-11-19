import { replica } from '@/lib/replica'
import { machineRpc } from './sessionpage-rpc'
import { loadCreationSkills } from './create-skills'
import { rendererLogger } from '@/lib/log'

const log = rendererLogger('mobile-create-skills')

/** One account-scoped reading per execution device, native harness and project. */
export const creationSkills = replica({
  name: 'phoneNativeCreationSkills.v1',
  scope: 'account',
  read: async (_owner, deviceId: string, harness: string, projectId: string | null) => {
    try { return await loadCreationSkills(machineRpc(deviceId).sessionTimeline, harness, projectId) }
    catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      log.warn({ deviceId, harness, projectId, code, error: String(error) }, 'native creation skills read failed')
      throw error
    }
  },
  fresh: 30_000,
})
