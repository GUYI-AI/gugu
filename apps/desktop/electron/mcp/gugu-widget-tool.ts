import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { serializeWidgetMessage, WIDGET_HEIGHT_MIN, WIDGET_HEIGHT_MAX, WIDGET_HEIGHT_ERROR } from '@gugu/core/shared/ui/widgetModels'
import type { AppSearchSource } from './gugu-app-search-tool'
import { assertMcpToolDescriptionWithinBudget } from './mcp-tool-description-budget.mjs'

const schema = z.object({
  chat_id: z.string().min(1), app: z.string().min(1), view: z.string().min(1), text: z.string(),
  height: z.number({ error: WIDGET_HEIGHT_ERROR }).int({ error: WIDGET_HEIGHT_ERROR })
    .min(WIDGET_HEIGHT_MIN, { error: WIDGET_HEIGHT_ERROR }).max(WIDGET_HEIGHT_MAX, { error: WIDGET_HEIGHT_ERROR }).optional(),
  data: z.record(z.string(), z.unknown()).optional(), reply_to_message_id: z.string().optional(),
}).strict()
export type WidgetSendArgs = z.infer<typeof schema>

export function registerGuguWidgetTool(server: McpServer, source: AppSearchSource,
  send: (args: WidgetSendArgs, content: string) => Promise<string>, get: (widgetId: string) => Promise<string>): void {
  const description = 'Send an App view in a chat message. The installed, enabled App must declare this widget view. height overrides the view\'s default. text is the plain preview (1–200 characters); data is immutable JSON, at most 4096 UTF-8 bytes. Does not wake agents. guide_read widgets explains callbacks.'
  assertMcpToolDescriptionWithinBudget('widget_send', description)
  server.registerTool('widget_send', { description, inputSchema: schema }, async args => {
    const found = source()
    if (!found) throw new Error('widget_send is unavailable here: Apps reach a session of yours, not a side chat')
    const { app, view, text, height, data } = args
    const content = serializeWidgetMessage({ v: 2, text, app, view, ...(height === undefined ? {} : { height }), ...(data === undefined ? {} : { data }) })
    const installed = (await found).apps.find(hit => hit.manifest.id === app && hit.state === 'on')
    if (!installed) throw new Error(`widget_send: ${app} must be installed, enabled and available to this session`)
    if (!installed.widgetViews?.some(tab => tab.view === view)) throw new Error(`widget_send: ${app} does not declare widget view ${view}`)
    return { content: [{ type: 'text', text: await send(args, content) }] }
  })
  const getDescription = 'Read a widget by its widget_id (from widget_send, a gugu-widget:// reference or an App\'s context): its chat, original message, app, view, text, height, data and sender. Read with your own permissions: a widget whose original you cannot read is not found.'
  assertMcpToolDescriptionWithinBudget('widget_get', getDescription)
  server.registerTool('widget_get', { description: getDescription, inputSchema: z.object({ widget_id: z.string().min(1) }).strict() },
    async ({ widget_id }) => ({ content: [{ type: 'text', text: await get(widget_id) }] }))
}
