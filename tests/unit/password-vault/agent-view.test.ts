import { describe, expect, it } from 'vitest'
import type { PasswordItem } from '../../../packages/core/src/shared/passwordBetaProtocol'
import { agentCredential, planAgentSave, searchCredentials } from '../../../apps/desktop/electron/password-vault/beta-agent-view'

const agent = 'agent:11111111-1111-4111-8111-111111111111'
let next = 0
const id = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
function item(origin: string, extra: Partial<PasswordItem> = {}): PasswordItem {
  return { reference: { id: id(), version: 1, epoch: 'e' }, name: '', origin, account: 'dev@example.com', maskedAccount: 'd***@example.com', accountSecret: false,
    hasPassword: true, fields: [], grants: [], sites: [], ...extra }
}

describe('what an Agent sees of a credential', () => {
  it('shows non-secret values only with access, and never a secret value', () => {
    const db = item('https://db.example.com', { name: '生产库', fields: [
      { id: id(), name: '主机', secret: false, value: 'db.example.com' }, { id: id(), name: 'API Key', secret: true }] })
    expect(agentCredential(db, [agent])).toMatchObject({ name: '生产库', maskedAccount: 'd***@example.com', access: 'ask',
      fields: [{ name: '主机', secret: false }, { name: 'API Key', secret: true }] })
    expect(agentCredential(db, [agent]).fields[0]).not.toHaveProperty('value')
    expect(agentCredential(db, [agent])).not.toHaveProperty('account')
    const granted = agentCredential({ ...db, grants: [{ subject: agent, level: 'read' }] }, [agent])
    expect(granted).toMatchObject({ account: 'dev@example.com', access: 'read', fields: [{ name: '主机', value: 'db.example.com' }, { name: 'API Key', secret: true }] })
    expect(granted.fields[1]).not.toHaveProperty('value')
    // A secret account shows masked even with access.
    const hidden = agentCredential({ ...db, account: undefined, accountSecret: true, grants: [{ subject: agent, level: 'write' }] }, [agent])
    expect(hidden).toMatchObject({ maskedAccount: 'd***@example.com' })
    expect(hidden).not.toHaveProperty('account')
    // Without a name, the website stands in.
    expect(agentCredential(item('https://github.com'), [agent]).name).toBe('github.com')
  })
})

describe('searching hundreds of credentials', () => {
  const views = [
    agentCredential(item('https://github.com', { name: '公司 GitHub', grants: [{ subject: agent, level: 'read' }] }), [agent]),
    agentCredential(item('https://gist.github.com', { name: '个人 Gist' }), [agent]),
    agentCredential(item('https://api.openai.com', { name: 'OpenAI 公司', account: '', maskedAccount: '', hasPassword: false,
      fields: [{ id: id(), name: 'API Key', secret: true }], sites: ['https://vercel.com'] }), [agent]),
    agentCredential(item('https://mail.example.com', { account: 'alice@corp.example', maskedAccount: 'a***@corp.example' }), [agent]),
  ]
  it('matches a site and its subdomains, including the sites a credential may be filled into', () => {
    expect(searchCredentials(views, { site: 'github.com' }).items.map(entry => entry.name)).toEqual(['公司 GitHub', '个人 Gist'])
    expect(searchCredentials(views, { site: 'https://vercel.com/dashboard' }).items.map(entry => entry.name)).toEqual(['OpenAI 公司'])
    expect(searchCredentials(views, { site: 'hub.com' }).total).toBe(0)
  })
  it('searches names and value names, and readable values only where the Agent has access', () => {
    expect(searchCredentials(views, { query: '公司' }).items.map(entry => entry.name)).toEqual(['公司 GitHub', 'OpenAI 公司'])
    expect(searchCredentials(views, { query: 'api key' }).items.map(entry => entry.name)).toEqual(['OpenAI 公司'])
    expect(searchCredentials(views, { query: 'dev@example.com' }).items.map(entry => entry.name)).toEqual(['公司 GitHub'])
    // alice@ belongs to a credential this Agent has no access to: searching for it must not confirm it exists.
    expect(searchCredentials(views, { query: 'alice@' }).total).toBe(0)
  })
  it('filters by value name and by usable, lists usable ones first, and pages', () => {
    expect(searchCredentials(views, { field: 'API Key' }).items.map(entry => entry.name)).toEqual(['OpenAI 公司'])
    expect(searchCredentials(views, { field: 'password' }).total).toBe(3)
    expect(searchCredentials(views, { usable: true }).items.map(entry => entry.name)).toEqual(['公司 GitHub'])
    expect(searchCredentials(views).items[0]!.name).toBe('公司 GitHub')
    expect(searchCredentials(views, { rows: '1-2' })).toMatchObject({ total: 4, rows: '1-2', next: '3-4' })
    expect(searchCredentials(views, { rows: '3-4' })).toMatchObject({ rows: '3-4' })
    expect(searchCredentials(views, { rows: '3-4' })).not.toHaveProperty('next')
    const many = Array.from({ length: 45 }, (_, index) => ({ ...views[0]!, credentialId: String(index) }))
    expect(searchCredentials(many)).toMatchObject({ total: 45, rows: '1-20', next: '21-40' })
  })
})

describe('an Agent saving a credential it may write', () => {
  const stored = () => item('https://db.example.com', { grants: [{ subject: agent, level: 'write' }], accountSecret: true, account: undefined,
    fields: [{ id: 'f-host', name: '主机', secret: false, value: 'db' }, { id: 'f-key', name: 'API Key', secret: true }] })
  it('saves at once: blank keeps stored values, new values come with their value, and it may make a value secret', () => {
    expect(planAgentSave(stored(), [agent], { fields: [{ name: '主机', secret: true }, { name: '端口', value: '5432', secret: false }] }, () => 'f-new')).toEqual([
      { id: 'f-host', name: '主机', value: '', secret: true }, { id: 'f-key', name: 'API Key', value: '', secret: true },
      { id: 'f-new', name: '端口', value: '5432', secret: false }])
  })
  it('hands it to the person when a secret value would stop being secret, a new value has no value, or there is no write access', () => {
    expect(planAgentSave(stored(), [agent], { fields: [{ name: 'API Key', secret: false }] }, id)).toBeNull()
    expect(planAgentSave(stored(), [agent], { accountSecret: false }, id)).toBeNull()
    expect(planAgentSave(stored(), [agent], { fields: [{ name: '新密钥' }] }, id)).toBeNull()
    expect(planAgentSave({ ...stored(), grants: [{ subject: agent, level: 'read' }] }, [agent], {}, id)).toBeNull()
    expect(planAgentSave(undefined, [agent], {}, id)).toBeNull()
  })
})
