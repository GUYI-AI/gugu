import { describe, expect, it } from 'vitest'
import { listAccountProjects } from '@gugu/core/cloud/deviceProjects'

const client = (data: unknown, error: { message: string } | null = null) => ({ rpc: async () => ({ data, error }) })

describe('identity.list_my_projects → account projects', () => {
  it('maps each project group with its name, archive state and per-device bindings (none is a project too)', async () => {
    await expect(listAccountProjects(client([
      { chat_id: 'c1', name: 'work', status: 'active', bindings: [{ device_id: 'gpu', local_project_id: 'p1', root_path: '/w' }] },
      { chat_id: 'c2', name: 'paper', status: 'archived', bindings: [] },
    ]))).resolves.toEqual([
      { chatId: 'c1', name: 'work', archived: false, bindings: [{ deviceId: 'gpu', localProjectId: 'p1' }] },
      { chatId: 'c2', name: 'paper', archived: true, bindings: [] },
    ])
  })

  it('fails loudly on an error or a malformed answer', async () => {
    await expect(listAccountProjects(client(null, { message: 'Not authenticated' }))).rejects.toThrow('Not authenticated')
    await expect(listAccountProjects(client({}))).rejects.toThrow('array')
    await expect(listAccountProjects(client([{ name: 'x' }]))).rejects.toThrow('chat_id')
  })
})
