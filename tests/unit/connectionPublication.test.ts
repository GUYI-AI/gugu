import { createHash } from 'node:crypto'
import { describe,expect,it,vi } from 'vitest'
import { publishConnectionObservations, type ConnectionObservation } from '../../apps/desktop/electron/sessionpage/connection-publication'
import { createConnectionClient,type ConnectionItem,type ConnectionSnapshot } from '../../packages/core/src/cloud/connections'
const row = (): ConnectionItem => ({ scopeKey: 'device:device',resourceKey: 'imported-key',deviceId: 'device',revision: '6',data: { providerId: 'github',accountId: 'one',configured: true },
  publicMetadata: null,document: null,bodySha256: null,deletedAt: null,staleAt: null,observedAt: null,updatedAt: '2026-11-07T00:00:00Z' })
const snapshot = (items: ConnectionItem[]): ConnectionSnapshot => ({ version: 1,state: 'ready',revision: '7',items,application: [] })
const observed = (): ConnectionObservation => ({ scopeKey: 'device:device',deviceId: 'device',data: row().data,document: '{"providerId":"github","accountId":"one"}' })
function setup() {
  const rpc = vi.fn(async (_name: string,args: Record<string,unknown>) => ({ data: { operationId: args.p_operation_id,revision: '8',status: 'applied',scopeKey: args.p_scope_key,resourceKey: args.p_resource_key },error: null }))
  const publish = (value: ConnectionSnapshot,observations = [observed()]) => publishConnectionObservations({ snapshot: value,observations,
    client: createConnectionClient(rpc,() => 'owner'),runtimeInstanceId: 'runtime' })
  return { rpc,publish }
}
describe('owner observations', () => {
  it('retains imported identity and uses item CAS plus the actual runtime', async () => {
    const { rpc,publish } = setup()
    await publish(snapshot([row()]))
    expect(rpc).toHaveBeenCalledExactlyOnceWith('connection_commit',expect.objectContaining({ p_resource_key: 'imported-key',p_expected_revision: '6',p_runtime_instance_id: 'runtime',p_recreation_id: null }))
  })
  it('never republishes a tombstone or treats a missing local account as a remove', async () => {
    const { rpc,publish } = setup()
    await publish(snapshot([{ ...row(),deletedAt: '2026-11-07T00:00:00Z' }]))
    await publish(snapshot([row()]),[])
    expect(rpc).not.toHaveBeenCalled()
  })
  it('keeps another device with an equal provider/account separate on first observation', async () => {
    const { rpc,publish } = setup()
    await publish(snapshot([{ ...row(),scopeKey: 'device:other',deviceId: 'other' }]))
    expect(rpc).toHaveBeenCalledWith('connection_commit',expect.objectContaining({ p_scope_key: 'device:device',p_expected_revision: '0',p_device_id: 'device' }))
  })
  it('refuses an ambiguous mapping rather than choosing or rebuilding a resource key', async () => {
    const { rpc,publish } = setup()
    await expect(publish(snapshot([row(),{ ...row(),resourceKey: 'second-key' }]))).rejects.toMatchObject({ code: 'ambiguous-resource' })
    expect(rpc).not.toHaveBeenCalled()
  })
})

/** As Postgres jsonb hands an object back: undefined gone, keys ordered by length then bytes, at every depth; arrays as they were. */
function jsonb(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonb)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([,item]) => item !== undefined)
    .sort(([a],[b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map(([key,item]) => [key,jsonb(item)]))
}
const sha = (text: string) => createHash('sha256').update(text,'utf8').digest('hex')
const DOCUMENT = '{"version":1,"en":{"name":"Feishu"}}'
const directory = (data: Record<string,unknown> = {}): ConnectionObservation => ({ scopeKey: 'device:device',resourceKey: 'catalog:feishu',deviceId: 'device',
  data: { providerId: 'feishu',configured: false,displayName: 'Feishu',catalog: { categoryId: 'docs',aliases: ['lark','飞书'] },...data },document: DOCUMENT })
const stored = (observation: ConnectionObservation, data: unknown = observation.data): ConnectionItem => ({ ...row(),resourceKey: 'catalog:feishu',
  data: jsonb(data) as Record<string,unknown>,bodySha256: sha(observation.document) })

describe('an unchanged row is unchanged as the backend stores it (#1922)', () => {
  it('nested keys read back in jsonb order, and undefined dropped: not republished', async () => {
    const { rpc,publish } = setup()
    const local = directory({ note: undefined })
    const item = stored(local)
    expect(Object.keys(item.data.catalog as object)).toEqual(['aliases','categoryId'])
    await publish(snapshot([item]),[local])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a real change at any depth is republished — an array keeps its order', async () => {
    for (const before of [
      { catalog: { categoryId: 'mail',aliases: ['lark','飞书'] } },
      { catalog: { categoryId: 'docs',aliases: ['飞书','lark'] } },
      { catalog: { categoryId: 'docs' } },
      { displayName: 'Lark' },
    ]) {
      const { rpc,publish } = setup()
      const local = directory()
      await publish(snapshot([stored(local,{ ...local.data,...before })]),[local])
      expect(rpc).toHaveBeenCalledExactlyOnceWith('connection_commit',expect.objectContaining({ p_resource_key: 'catalog:feishu',p_data: local.data }))
    }
  })

  it('rounds against an unchanged backend commit once, then never again', async () => {
    const items = new Map<string,ConnectionItem>()
    let revision = 0
    const rpc = vi.fn(async (_name: string,args: Record<string,unknown>) => {
      revision += 1
      const key = String(args.p_resource_key)
      items.set(key,{ ...row(),resourceKey: key,revision: String(revision),data: jsonb(JSON.parse(JSON.stringify(args.p_data))) as Record<string,unknown>,
        document: String(args.p_document),bodySha256: sha(String(args.p_document)) })
      return { data: { operationId: args.p_operation_id,revision: String(revision),status: 'applied',scopeKey: args.p_scope_key,resourceKey: key },error: null }
    })
    const client = createConnectionClient(rpc,() => 'owner')
    const observations = [directory(),{ ...directory(),resourceKey: 'catalog:github',data: { ...directory().data,providerId: 'github',catalog: { categoryId: 'code',aliases: ['gh'] } } }]
    const commits: number[] = []
    for (let round = 0; round < 5; round += 1) {
      const before = rpc.mock.calls.length
      await publishConnectionObservations({ snapshot: snapshot([...items.values()]),observations,client,runtimeInstanceId: 'runtime' })
      commits.push(rpc.mock.calls.length - before)
    }
    expect(commits).toEqual([2,0,0,0,0])
  })
})
