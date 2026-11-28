import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { assistantStartupIndex, writeResourceOverflow, type AssistantStartupIndexDeps } from '../sessionpage/assistant-startup-index'

/** The native assistant hooks use the same authenticated action router as the listed tools. */
export function registerAssistantResource(server: McpServer, deps: AssistantStartupIndexDeps, guguHome?: string): void {
  server.registerResource('gugu-resource-index', 'gugu://assistant/resources', { mimeType: 'text/plain' }, async uri => {
    const owner = await deps.accountId()
    if (!owner) throw new Error('Assistant resource owner is unavailable')
    const index = await assistantStartupIndex({ ...deps, ...(guguHome ? {
      overflow: async (index: string, observedOwner: string) => {
        if (observedOwner !== owner || await deps.accountId() !== owner) throw new Error('Assistant resource account changed')
        return writeResourceOverflow(guguHome, owner, index)
      },
    } : {}) })
    if (await deps.accountId() !== owner) throw new Error('Assistant resource account changed before delivery')
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: index }] }
  })
}
