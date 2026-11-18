import { expect, it } from 'vitest'
import { withContractDatabase } from './database'
import { randomUUID } from 'node:crypto'

it.each(['hide_my_conversation', 'delete_my_conversation'])('exposes %s only through the authenticated idempotent RPC', async name => {
  await withContractDatabase(async db => {
    const result = await db.query(`SELECT p.proargnames AS names,pg_get_function_result(p.oid) AS result,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [`chat.${name}(text,uuid)`])
    expect(result.rows).toEqual([{ names: ['p_chat_id', 'p_operation_id'], result: 'jsonb', authenticated: true, anonymous: false, service: false }])
  })
})

it('returns decimal-string revisions and a caller-only clear boundary while the peer retains the message', async () => {
  await withContractDatabase(async db => {
    await db.query('BEGIN')
    const [owner, peer, chat, message, operation] = Array.from({ length: 5 }, randomUUID)
    try {
      await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2),($3,$4)', [owner, owner + '@contract.test', peer, peer + '@contract.test'])
      await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Contract',$2)", [chat, owner])
      await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [chat, owner, peer])
      await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,created_at) VALUES($1,$2,$3,'retained for peer',clock_timestamp())", [message, chat, peer])
      await db.query('SET LOCAL ROLE authenticated')
      const as = (id: string) => db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',json_build_object('sub',$1::text,'role','authenticated')::text,true)", [id])
      await as(owner)
      const result = await db.query<{ receipt: { operation_id: string; account_revision: string; cleared_at: string } }>('SELECT chat.delete_my_conversation($1,$2) AS receipt', [chat, operation])
      const receipt = result.rows[0].receipt
      expect(receipt.operation_id).toBe(operation)
      expect(receipt.account_revision).toMatch(/^[1-9][0-9]*$/)
      expect(Number.isFinite(Date.parse(receipt.cleared_at))).toBe(true)
      expect((await db.query('SELECT id FROM chat.messages_view WHERE chat_id=$1', [chat])).rows).toEqual([])
      const state = await db.query<{ cleared: string }>("SELECT to_jsonb(m)->>'conversation_cleared_at' AS cleared FROM chat.list_conversation_memberships(ARRAY[$1]) m WHERE m.user_id=$2", [chat, owner])
      expect(state.rows[0].cleared).toBe(receipt.cleared_at)
      await as(peer)
      expect((await db.query('SELECT id FROM chat.messages_view WHERE chat_id=$1', [chat])).rows).toEqual([{ id: message }])
    } finally { await db.query('ROLLBACK') }
  })
})

it('exposes the personal deletion RPC contract only to authenticated callers', async () => {
  await withContractDatabase(async db => {
    const result = await db.query(`SELECT p.proargnames AS names,pg_get_function_result(p.oid) AS result,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service
      FROM pg_proc p WHERE p.oid='chat.delete_my_dm_conversation(text)'::regprocedure`)
    expect(result.rows).toEqual([{names:['p_chat_id'],result:'jsonb',authenticated:true,anonymous:false,service:false}])
  })
})

it('allows the client to read personal list state without granting direct mutation of the retained membership', async () => {
  await withContractDatabase(async db => {
    await db.query('BEGIN')
    try {
      await db.query('SET LOCAL ROLE authenticated')
      await db.query('SELECT conversation_deleted_at FROM chat.active_members WHERE false')
      const result = await db.query(`SELECT has_column_privilege('authenticated','chat.chat_members','conversation_deleted_at','UPDATE') AS allowed`)
      expect(result.rows).toEqual([{allowed:false}])
    } finally { await db.query('ROLLBACK') }
  })
})
