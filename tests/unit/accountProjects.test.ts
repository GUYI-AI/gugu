import { describe, expect, it } from 'vitest'
import { listAccountProjects } from '@gugu/core/cloud/deviceProjects'

const client = (data: unknown, error: { message: string } | null = null) => ({ rpc: async () => ({ data, error }) })

describe('identity.list_my_projects → account projects', () => {
  it('maps each project group with its name, archive state and per-device bindings (none is a project too)', async () => {
    await expect(listAccountProjects(client([
      { chat_id: 'c1', name: 'work', status: 'active', created_at: '2026-11-01T08:00:00+00:00', last_message_at: '2026-11-12T09:30:00.5+00:00', bindings: [{ device_id: 'gpu', local_project_id: 'p1', root_path: '/w' }] },
      { chat_id: 'c2', name: 'paper', status: 'archived', created_at: '2026-11-02T08:00:00+00:00', last_message_at: null, bindings: [] },
    ]))).resolves.toEqual([
      { chatId: 'c1', name: 'work', archived: false, activeAt: '2026-11-12T09:30:00.500Z', bindings: [{ deviceId: 'gpu', localProjectId: 'p1' }] },
      { chatId: 'c2', name: 'paper', archived: true, activeAt: '2026-11-02T08:00:00.000Z', bindings: [] },
    ])
  })

  // #2548 a project whose group is not in the chat list yet is ordered among the conversations by the time its group's
  // conversation row will have (chatActivityAt: last message, else creation), read from the same row.
  it('reads when the group was last active: its last message, else its creation; neither is a malformed answer', async () => {
    await expect(listAccountProjects(client([{ chat_id: 'c1', name: 'work', status: 'active', bindings: [] }]))).rejects.toThrow('created_at')
    await expect(listAccountProjects(client([{ chat_id: 'c1', name: 'work', status: 'active', created_at: 'yesterday', bindings: [] }]))).rejects.toThrow('created_at')
  })

  it('fails loudly on an error or a malformed answer', async () => {
    await expect(listAccountProjects(client(null, { message: 'Not authenticated' }))).rejects.toThrow('Not authenticated')
    await expect(listAccountProjects(client({}))).rejects.toThrow('array')
    await expect(listAccountProjects(client([{ name: 'x' }]))).rejects.toThrow('chat_id')
  })
})
