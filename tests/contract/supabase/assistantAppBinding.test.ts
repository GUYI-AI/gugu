/** The assistant client reads an ordinary account-bound agent from the installed community RPC. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ASSISTANT_BINDING_ARGS, ASSISTANT_BINDING_RPC, pickAssistant } from '@gugu/core/shared/assistantProvision'
import { withContractDatabase } from './database'

describe('assistant App binding client/database contract', () => {
  it('uses the owner-scoped RPC without a provision marker and preserves its empty result on unbind', async () => {
    await withContractDatabase(async (db) => {
      await db.query('BEGIN')
      try {
        const owner = randomUUID(), stranger = randomUUID(), agent = randomUUID(), device = randomUUID()
        for (const user of [owner, stranger]) {
          await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
            VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [user, `${user}@binding-contract.invalid`])
          await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Contract') ON CONFLICT DO NOTHING", [user])
        }
        await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'contract','contract','linux')", [device, owner])
        await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Ordinary agent',$2,$3)", [agent, owner, device])
        const as = async <T>(user: string, action: () => Promise<T>): Promise<T> => {
          await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
          await db.query('SET LOCAL ROLE authenticated')
          try { return await action() } finally { await db.query('RESET ROLE') }
        }
        const read = (user: string) => as(user, async () => pickAssistant((await db.query(
          `SELECT * FROM identity.${ASSISTANT_BINDING_RPC}(p_app_id => $1)`, [ASSISTANT_BINDING_ARGS.p_app_id])).rows))
        await expect(read(owner)).resolves.toBeNull()
        await as(owner, () => db.query('SELECT identity.bind_app_agent($1,$2)', [ASSISTANT_BINDING_ARGS.p_app_id, agent]))
        await expect(read(owner)).resolves.toEqual({ agentId: agent, deviceId: device })
        await expect(read(stranger)).resolves.toBeNull()
        expect((await as(stranger, () => db.query('SELECT * FROM identity.app_agent_bindings'))).rows).toEqual([])
        expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','identity.my_app_agent(text)','EXECUTE') AS allowed")).rows[0]!.allowed).toBe(false)
        await as(owner, () => db.query('SELECT identity.unbind_app_agent($1)', [ASSISTANT_BINDING_ARGS.p_app_id]))
        await expect(read(owner)).resolves.toBeNull()
      } finally { await db.query('ROLLBACK') }
    })
  })
})
