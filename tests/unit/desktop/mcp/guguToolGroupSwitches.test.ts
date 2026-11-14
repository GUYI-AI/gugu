import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { applyGuguToolsOff, createDesktopGuguMcpHost, guguMcpTools, setGuguToolsOffReader, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { setExtensionCheckAvailable } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
import { GUGU_TOOL_GROUPS, guguToolGroupOf, guguToolsOffFromStored, guguToolsOffSchema, type GuguToolsOff } from '../../../../apps/desktop/src/session/shared/gugu-tool-groups'

// 资源库 → MCP 的内置工具组开关:起真 host、按会话页 agent 的 grant 连真客户端,看 agent 实际拿到的清单与目录。
let host: DesktopGuguMcpHost | undefined
afterEach(async () => {
  setGuguToolsOffReader(async () => [])
  setExtensionCheckAvailable(false)
  await host?.dispose().catch(() => undefined)
  host = undefined
})

async function connect(off: GuguToolsOff) {
  setGuguToolsOffReader(async () => off)
  setExtensionCheckAvailable(true)
  host = createDesktopGuguMcpHost()
  await host.start()
  const grant = await host.grant('tool-groups', {
    kind: 'social',
    expectedOwnerUserId: 'owner-1',
    subjectId: 'agent-1',
    supabaseUrl: 'https://supabase.example',
    anonKey: 'anon-key',
    agentId: 'agent-1',
    threadRootId: null,
    guguHome: '/tmp/gugu-tool-groups',
    getAccessToken: async () => 'token',
    runSessionAction: async () => ({}),
    runExtensionAction: async () => ({}),
  })
  const client = new Client({ name: 'tool-groups-probe', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
  }))
  return client
}

const catalogNames = async (client: Client) => {
  const listed = await client.callTool({ name: 'catalog_list', arguments: { rows: '1-500' } })
  return (listed.content as Array<{ text: string }>)[0]!.text
}

describe('built-in gugu tool groups', () => {
  it('every tool the host registers belongs to a group', async () => {
    const names = (await guguMcpTools()).map((tool) => tool.name)
    // 阳控:列的是整台(原生 + 目录),不是空清单。
    expect(names).toEqual(expect.arrayContaining(['message_send', 'session_spawn', 'device_call', 'app_install', 'web_search', 'catalog_list']))
    expect(names.filter((name) => !guguToolGroupOf(name))).toEqual([])
    for (const name of ['activity_list', 'activity_context', 'activity_chat_list']) expect(guguToolGroupOf(name)).toBeDefined()
  })

  it('a group switched off is gone from tools/list and the catalog; the rest stays', async () => {
    const client = await connect(['devices', 'apps', 'schedules'])
    const listed = (await client.listTools()).tools.map((tool) => tool.name)
    expect(listed).toEqual(expect.arrayContaining(['message_send', 'session_message', 'catalog_call']))
    expect(listed.filter((name) => ['devices', 'apps', 'schedules'].includes(guguToolGroupOf(name)!))).toEqual([])
    const catalog = await catalogNames(client)
    expect(catalog).toContain('project_create')
    for (const gone of ['app_install', 'app_search', 'widget_send', 'schedule_list', 'device_call']) expect(catalog).not.toContain(gone)
    const call = await client.callTool({ name: 'catalog_call', arguments: { tool: 'device_call', args: {} } })
    expect(call.isError).toBe(true)
    expect((call.content as Array<{ text: string }>)[0]!.text).toContain('no tool named device_call')
    await client.close()
  })

  it('all on: the switched groups are back', async () => {
    const client = await connect([])
    const listed = (await client.listTools()).tools.map((tool) => tool.name)
    expect(listed).toEqual(expect.arrayContaining(['device_actions', 'device_call', 'schedule_create']))
    expect(await catalogNames(client)).toContain('app_install')
    await client.close()
  })

  it('a switch flipped while a client is connected reaches it at once: list_changed, then the new list', async () => {
    const client = await connect([])
    let notified = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { notified += 1 })
    // a GET stream for server-initiated notifications is opened lazily; one request makes sure it is up
    await client.listTools()
    applyGuguToolsOff(['schedules'])
    await expect.poll(() => notified, { timeout: 5000 }).toBeGreaterThan(0)
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('schedule_create')
    expect(await catalogNames(client)).not.toContain('schedule_list')
    const call = await client.callTool({ name: 'schedule_create', arguments: {} })
    expect(call.isError).toBe(true)
    applyGuguToolsOff([])
    await expect.poll(async () => (await client.listTools()).tools.map((tool) => tool.name)).toContain('schedule_create')
    await client.close()
  })

  it('a stored id this build does not know, or a locked one, is dropped on read instead of failing every session', () => {
    expect(guguToolsOffFromStored(['schedules', 'apps-v0', 'messages', 7])).toEqual(['schedules'])
    expect(guguToolsOffFromStored(null)).toEqual([])
    expect(guguToolsOffFromStored({ devices: true })).toEqual([])
  })

  it('locked groups cannot be stored as off', () => {
    for (const group of GUGU_TOOL_GROUPS.filter((item) => item.locked)) {
      expect(guguToolsOffSchema.safeParse([group.id]).success).toBe(false)
    }
    expect(guguToolsOffSchema.parse(['devices'])).toEqual(['devices'])
  })
})
