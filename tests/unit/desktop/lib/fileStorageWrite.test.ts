import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ config: {} as Record<string, unknown>, writes: [] as Record<string, unknown>[], overview: null as unknown }))
vi.mock('@gugu/core/cloud/userSettings', () => ({
  readUserSettingsConfig: async () => io.config,
  updateUserSettingsKey: async (_client: unknown, _user: string, scope: string, key: string, edit: (value: unknown) => unknown) => {
    const config = { ...io.config, [key]: edit(io.config[key]) }
    io.writes.push(config); io.config = config
    return { scope, config }
  },
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {}, chatDb: { rpc: async () => ({ data: io.overview, error: null }) } }))
const { readFileStorage, readFileStorageOverview, writeFileStorage } = await import('../../../../apps/desktop/src/lib/fileStorage')

describe('the file storage setting across client versions', () => {
  beforeEach(() => {
    io.writes = []
    io.config = { other: 'keep', file_storage: { image_retention: '30d', temporary_retention: '1d', later_key: { any: 1 } } }
  })
  it('reads a setting a newer client wrote, and writing back keeps the keys this client does not know', async () => {
    expect(await readFileStorage('u')).toMatchObject({ image_retention: '30d', retention: '7d' })
    await writeFileStorage('u', { retention: '1d' })
    expect(io.writes).toEqual([{ other: 'keep', file_storage: {
      proactive_upload: false, temporary_transfer: true, retention: '1d', image_retention: '30d', temporary_retention: '1d', later_key: { any: 1 },
    } }])
  })
})

describe('the storage overview', () => {
  it('requires the deployment\'s expiry policy (null when it sets none) and refuses a backend that does not send it', async () => {
    io.overview = { total_bytes: 0, count: 0, classes: {} }
    await expect(readFileStorageOverview()).rejects.toThrow(/expiry policy/)
    io.overview = { total_bytes: 0, count: 0, classes: {}, expiry: null }
    expect((await readFileStorageOverview()).expiry).toBeNull()
    io.overview = { total_bytes: 0, count: 0, classes: {}, expiry: { large_file_bytes: 1048576, idle_seconds: 2592000 } }
    expect((await readFileStorageOverview()).expiry).toEqual({ large_file_bytes: 1048576, idle_seconds: 2592000 })
  })
})
