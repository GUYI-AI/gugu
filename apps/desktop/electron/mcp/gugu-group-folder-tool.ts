// group_folder* — a group's folders on one of the owner's devices (@@@group-folders). A group is the only container; a
// folder is a directory on one device bound to at most one group. Files, sessions and history never move with a binding.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { encodeTypedId } from '@gugu/core/shared/typedId.mjs'
import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import { registerSessionpageTools, type SessionDispatcher, type SessionpageToolDef } from './sessionpage-tool-registrar'
import { listWindowShape } from './list-window.mjs'

const chat_id = z.string().min(1).describe('The group. A project:<id> from older results is the same group.')
const device = z.string().min(1).describe('device:<id> from session_devices; omit for this machine.').optional()
const path = z.string().min(1).describe('An existing absolute directory on that device.')

export const GROUP_FOLDER_TOOL_DEFS: readonly SessionpageToolDef[] = [
  {
    name: 'group_folders', action: 'group_folders',
    description: 'Folders bound to groups on one of your devices: without chat_id every bound folder, with it that group\'s in order (the first is where a new task starts). Each has folder_id, path, branch and running sessions.',
    schema: z.object({ chat_id: chat_id.optional(), device, ...listWindowShape }).strict(),
    list: { namesOf: (row) => [row.path] },
  },
  {
    name: 'group_folder_bind', action: 'group_folder_bind',
    description: 'Bind a directory on a device to a group. One group per folder per device: bound elsewhere answers folder_bound_elsewhere with its chat_id; move:true moves it. Sessions keep their group; files stay.',
    schema: z.object({ chat_id, path, device, move: z.boolean().optional() }).strict(),
  },
  {
    name: 'group_folder_unbind', action: 'group_folder_unbind',
    description: 'Unbind a folder from its group. Files, sessions and history stay. Returns undo (group_folder_bind arguments).',
    schema: z.object({ chat_id, folder_id: z.string().min(1).describe('From group_folders.'), device }).strict(),
  },
]

export function registerGuguGroupFolderTools(server: McpServer, run: SessionDispatcher | undefined, track: GuguMcpRequestTracker): void {
  const dispatch: SessionDispatcher | undefined = run ? async (action, signal) => {
    const result = await run(action, signal)
    const target = (action as { device?: string }).device
    // An undo made on another device must go back to it.
    if (!target || !result || typeof result !== 'object' || Array.isArray(result)) return result
    const record = result as Record<string, unknown>
    return record.undo && typeof record.undo === 'object' ? { ...record, undo: { ...record.undo, device: encodeTypedId('device', target) } } : record
  } : undefined
  registerSessionpageTools(server, GROUP_FOLDER_TOOL_DEFS, dispatch, (tool) => `${tool} is unavailable for this grant`, track)
}
