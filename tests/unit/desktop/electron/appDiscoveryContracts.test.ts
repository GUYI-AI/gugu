import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerGuguAppSearchTool, type AppSearchHit } from '../../../../apps/desktop/electron/mcp/gugu-app-search-tool'
import { registerGuguCatalogTools } from '../../../../apps/desktop/electron/mcp/gugu-catalog-tools'

const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())) })

async function discovery() {
  const server = new McpServer({ name: 'app-discovery-contract', version: '1' })
  const apps = Array.from({ length: 15 }, (_, i): AppSearchHit => ({
    manifest: { id: `demo-${i}`, name: `Demo ${String(i).padStart(2, '0')}`, defaultLocale: 'en', version: '1.0.0', apiVersion: 25, contributes: { tabs: [] } },
    state: 'on', version: '1',
  }))
  registerGuguAppSearchTool(server, async () => ({ apps }))
  registerGuguCatalogTools(server, async () => [])
  const client = new Client({ name: 'discovery-test', version: '1' })
  clients.push(client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>) {
  return (result.content as { type: string; text?: string }[]).filter(item => item.type === 'text').map(item => item.text).join('\n')
}

it('advertises array filters in compact discovery and accepts the advertised shape', async () => {
  const client = await discovery()
  const listing = await client.callTool({ name: 'catalog_list', arguments: { name: 'Find Apps' } })
  expect(textOf(listing)).toContain('state?: string[]')
  const invalid = await client.callTool({ name: 'catalog_call', arguments: { tool: 'app_search', args: { state: 'on' } } })
  expect(invalid.isError).toBe(true)
  const valid = await client.callTool({ name: 'catalog_call', arguments: { tool: 'app_search', args: { state: ['on'] } } })
  expect(valid.isError).not.toBe(true)
  expect(JSON.parse(textOf(valid)).items).toHaveLength(7)
})

it('publishes the seven-row bound in both discovery description and the rows schema', async () => {
  const client = await discovery()
  const exact = JSON.parse(textOf(await client.callTool({ name: 'catalog_list', arguments: { name: 'app_search' } })))
  expect(exact.description).toContain('at most 7 rows')
  expect(exact.inputSchema.properties.rows.description).toContain('at most 7 rows')
  expect(exact.inputSchema.properties.rows.description).toContain('all')
})

it('pages at the documented bound and rejects larger windows and all', async () => {
  const client = await discovery()
  const first = JSON.parse(textOf(await client.callTool({ name: 'app_search', arguments: { state: ['on'] } })))
  const next = JSON.parse(textOf(await client.callTool({ name: 'app_search', arguments: { rows: '8-14' } })))
  expect(first.items).toHaveLength(7)
  expect(first.next).toBe('8-14')
  expect(next.items).toHaveLength(7)
  expect(next.items.map((item: { app: string }) => item.app).some((id: string) => first.items.some((item: { app: string }) => item.app === id))).toBe(false)
  for (const rows of ['1-8', 'all']) {
    const refused = await client.callTool({ name: 'app_search', arguments: { rows } })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('at most 7 rows')
  }
})
