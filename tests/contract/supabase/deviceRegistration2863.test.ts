import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { registerGuguDevice, type DeviceRegistrationClient, type DeviceRegistrationInput } from '@gugu/core/cloud/deviceRegistration'
import { resolveLocalDeviceId, syncDeviceHeartbeat, type DeviceHeartbeatTableClient } from '@gugu/core/cloud/deviceRuntime'
import { withContractDatabase } from './database'

/** Exercise the shipped client payload/receipt against the installed RPC with PostgREST's auth role.
 * Every RPC gets its own real connection and transaction, including the concurrent registrations. */
function clientAs(owner: string): DeviceRegistrationClient {
  return {
    async rpc(name, args) {
      if (name !== 'register_gugu_device') throw new Error(`unexpected RPC ${name}`)
      return await withContractDatabase(async db => {
        await db.query('BEGIN')
        try {
          await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
          await db.query('SET LOCAL ROLE authenticated')
          const result = await db.query<{ receipt: unknown }>('SELECT identity.register_gugu_device(p_device => $1::jsonb) AS receipt', [JSON.stringify(args.p_device)])
          await db.query('COMMIT')
          return { data: result.rows[0]?.receipt, error: null }
        } catch (cause) {
          await db.query('ROLLBACK')
          const error = cause as Error & { code?: string }
          return { data: null, error: { code: error.code, message: error.message } }
        }
      })
    },
  }
}

async function fixture(body: (owner: string, input: DeviceRegistrationInput) => Promise<void>): Promise<void> {
  const owner = randomUUID()
  const input: DeviceRegistrationInput = {
    device_id: randomUUID(), machine_id: randomUUID(), tier: 'beta', label: 'Contract computer',
    hostname: 'contract', platform: 'linux', capabilities: { host_kind: 'desktop', terminals: [], runtimes: ['codex'] },
  }
  await withContractDatabase(async db => {
    try {
      await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
        VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [owner, `${owner}@2863.example.invalid`])
      await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','2863')
        ON CONFLICT (id) DO NOTHING`, [owner])
      await body(owner, input)
    } finally {
      await db.query('DELETE FROM identity.gugu_devices WHERE user_id=$1', [owner])
      await db.query('DELETE FROM identity.users WHERE id=$1', [owner])
      await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
    }
  })
}

async function rows(owner: string) {
  return await withContractDatabase(async db => (await db.query<{ device_id: string; status: string; label: string; capabilities: Record<string, unknown> }>(
    'SELECT device_id,status,label,capabilities FROM identity.gugu_devices WHERE user_id=$1', [owner])).rows)
}

describe('atomic device registration client/database contract #2863', () => {
  it('resolves an old tuple to its canonical ID before caching, then successfully registers that one row', async () => {
    await fixture(async (owner, input) => {
      const oldId = randomUUID()
      await withContractDatabase(async db => {
        await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,machine_id,tier,label,hostname,platform,status,capabilities)
          VALUES ($1,$2,$3,$4,'Custom label','old','linux','offline',$5::jsonb)`, [oldId, owner, input.machine_id, input.tier,
          JSON.stringify({ host_kind: 'desktop', terminals: [], runtimes: ['old'] })])
      })
      const client = { ...clientAs(owner), from: () => { throw new Error('raw registration is forbidden') } } as unknown as DeviceHeartbeatTableClient
      const cached: string[] = []
      const env = { GUGU_TIER: input.tier }
      const deviceId = await resolveLocalDeviceId({ userId: owner, heartbeatClient: client, env,
        machineIdentifier: () => input.machine_id, deviceIdCacheWriter: async (_path, id) => { cached.push(id) } })
      expect(deviceId).toBe(oldId)
      expect(cached).toEqual([oldId])
      expect(await rows(owner)).toMatchObject([{ device_id: oldId, status: 'offline', label: 'Custom label', capabilities: { runtimes: ['old'] } }])
      await syncDeviceHeartbeat(client, { userId: owner, deviceId, machineIdentifier: () => input.machine_id,
        hostname: () => input.hostname, platform: () => input.platform, capabilities: { terminals: [], runtimes: ['codex'] } }, env)
      expect(await rows(owner)).toMatchObject([{ device_id: oldId, status: 'online', label: 'Custom label', capabilities: { runtimes: ['codex'] } }])
      expect(await rows(owner)).toHaveLength(1)
    })
  })

  it('accepts concurrent new IDs for one tuple without a unique-key error and returns one canonical row', async () => {
    await fixture(async (owner, input) => {
      const client = clientAs(owner)
      const registered = await Promise.all([input, { ...input, device_id: randomUUID() }].map(value => registerGuguDevice(client, value)))
      expect(registered[0].deviceId).toBe(registered[1].deviceId)
      expect(registered.filter(value => value.created)).toHaveLength(1)
      expect(await rows(owner)).toMatchObject([{ device_id: registered[0].deviceId, status: 'online' }])
      expect(await rows(owner)).toHaveLength(1)
    })
  })

  it('rejects a historical phone-ID conflict explicitly and leaves its old row unchanged', async () => {
    await fixture(async (owner, input) => {
      const historical = { ...input, platform: 'android', capabilities: { host_kind: 'phone', terminals: [], runtimes: [] } }
      await withContractDatabase(async db => {
        await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,machine_id,tier,label,hostname,platform,status,capabilities)
          VALUES ($1,$2,$3,$4,'Old phone','old','android','offline',$5::jsonb)`, [historical.device_id, owner, historical.machine_id,
          historical.tier, JSON.stringify(historical.capabilities)])
      })
      const before = await rows(owner)
      const deviceId = `phone-${input.machine_id}-${owner}`
      await expect(registerGuguDevice(clientAs(owner), { ...historical, device_id: deviceId }, { expectedDeviceId: deviceId }))
        .rejects.toMatchObject({ code: 'P0001', message: 'PHONE_DEVICE_ID_CONFLICT' })
      expect(await rows(owner)).toEqual(before)
    })
  })
})
