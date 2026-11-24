import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractClientDataContract,
  extractClientEdgeFunctions,
  extractClientRpcContract,
} from '../../../scripts/checks/supabase-client-contract.mjs'

const dirs: string[] = []
function tree(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'supabase-client-contract-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'call.ts'), source)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('supabase client contract source rule', () => {
  it('reads an RPC whose arguments are an object literal at the call', () => {
    const dir = tree("chatDb.rpc('workspace_get_as', { p_item_id: itemId, p_as_user_id: actorId })")
    expect(extractClientRpcContract([dir], dir).get('workspace_get_as')?.args).toEqual(['p_as_user_id', 'p_item_id'])
  })

  it('refuses an RPC whose arguments are a variable holding the object', () => {
    // The shape that shipped to a release gate: the keys exist only on the variable, not at the call.
    const dir = tree([
      'const args = { p_item_id: itemId, p_as_user_id: actorId }',
      "chatDb.rpc('workspace_get_as', args)",
      "chatDb.rpc('workspace_versions_as', args)",
    ].join('\n'))
    expect(() => extractClientRpcContract([dir], dir))
      .toThrow(/cannot read 2 client \.rpc\(\) call site\(s\)[\s\S]*call\.ts:2 — workspace_get_as: argument is not an object literal/)
  })

  it('reads a select whose table and columns are literals, and refuses one whose table is computed', () => {
    const exact = tree("db.from('users').select('id,display_name')")
    expect([...extractClientDataContract([exact], exact).values()])
      .toEqual([{ schema: null, table: 'users', columns: ['display_name', 'id'], sites: ['call.ts:1'] }])
    const computed = tree("db.from(pickTable()).select('id')")
    expect(() => extractClientDataContract([computed], computed)).toThrow(/cannot read 1 client data select site/)
  })

  it('takes reviewed shapes and schemas only from its caller', () => {
    const rpc = tree("db.rpc('send', { p_id: id })")
    const extraRpc = () => ({ name: 'send', args: ['p_extra'], sites: ['transport.ts:1'] })
    expect(extractClientRpcContract([rpc], rpc, () => true, { extraRpc }).get('send'))
      .toEqual({ args: ['p_extra', 'p_id'], sites: ['call.ts:1', 'transport.ts:1'] })

    const edge = tree('client.functions.invoke(request.endpoint)')
    expect(() => extractClientEdgeFunctions([edge])).toThrow(/cannot read 1 Edge Function call site/)
    expect([...extractClientEdgeFunctions([edge], { reviewedNames: () => ['team-accounts'] })]).toEqual(['team-accounts'])

    const data = tree("db.from('users').select('id')")
    const unproved = new Error('schema not provable')
    const schemaProof = () => () => { throw unproved }
    expect(() => extractClientDataContract([data], data, () => true, { schemaProof })).toThrow(/schema not provable/)
    const tolerated: string[] = []
    const tolerate = (error: unknown, site: string) => error === unproved && tolerated.push(site) > 0
    expect(extractClientDataContract([data], data, () => true, { schemaProof, tolerate }).size).toBe(0)
    expect(tolerated).toEqual(['call.ts:1'])
    expect([...extractClientDataContract([data], data, () => true, { schemaProof: () => () => ['identity'] }).keys()])
      .toEqual(['identity.users'])
  })
})
