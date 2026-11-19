import { describe, expect, it, vi } from 'vitest'
import {
  DEVICE_PROJECT_PAGE_ROWS,
  listDeviceProjects,
  normalizeDeviceProjectRow,
  publishDeviceProjects,
  withDeviceProjects,
  type DeviceProject,
} from '../../../../packages/core/src/cloud/deviceProjects'

// #113 项目记在账号上:每台机器整份记它的项目,别的端读账号上的那份。

const project = (overrides: Partial<DeviceProject> = {}): DeviceProject => ({
  localProjectId: 'p1',
  name: 'repo',
  rootPath: '/srv/repo',
  createdAt: '2026-10-01T08:00:00.000Z',
  chatId: 'chat-1',
  folders: [
    { workspaceId: 'ws-root', kind: 'root', path: '/srv/repo', attachedAt: null },
    { workspaceId: 'ws-wt', kind: 'attached', path: '/srv/repo-wt', attachedAt: '2026-10-02T00:00:00.000Z' },
  ],
  ...overrides,
})

const row = (overrides: Record<string, unknown> = {}) => ({
  device_id: 'dev-1',
  local_project_id: 'p1',
  name: 'repo',
  root_path: '/srv/repo',
  created_at: '2026-10-01T08:00:00+00:00',
  chat_id: 'chat-1',
  group_representative: false,
  folders: [
    { workspace_id: 'ws-root', kind: 'root', path: '/srv/repo', attached_at: null },
    { workspace_id: 'ws-wt', kind: 'attached', path: '/srv/repo-wt', attached_at: '2026-10-02T00:00:00.000Z' },
  ],
  ...overrides,
})

describe('publishDeviceProjects', () => {
  it('sends the whole set in the shape the database checks and reports whether it changed', async () => {
    const rpc = vi.fn(async () => ({ data: { changed: true, rejected: [] } as unknown, error: null }))
    await expect(publishDeviceProjects({ rpc }, 'dev-1', [project()])).resolves.toEqual({ changed: true, rejected: [] })
    expect(rpc).toHaveBeenCalledWith('publish_device_projects_v2', {
      p_device_id: 'dev-1',
      p_projects: [{
        local_project_id: 'p1',
        name: 'repo',
        root_path: '/srv/repo',
        created_at: '2026-10-01T08:00:00.000Z',
        chat_id: 'chat-1',
        // group_representative 不再发:库里那一列缺省 false(阶段 B 删列)。
        folders: [
          { workspace_id: 'ws-root', kind: 'root', path: '/srv/repo', attached_at: null },
          { workspace_id: 'ws-wt', kind: 'attached', path: '/srv/repo-wt', attached_at: '2026-10-02T00:00:00.000Z' },
        ],
      }],
    })
    rpc.mockResolvedValueOnce({ data: { changed: false, rejected: ['p1'] }, error: null })
    await expect(publishDeviceProjects({ rpc }, 'dev-1', [project()])).resolves.toEqual({ changed: false, rejected: ['p1'] })
  })

  it('an answer in another shape (the old boolean) is an error, ❌ read as "nothing refused"', async () => {
    const rpc = async () => ({ data: true, error: null })
    await expect(publishDeviceProjects({ rpc }, 'dev-1', [project()])).rejects.toThrow(/\{changed, rejected\}/)
  })

  it('throws what the database refused', async () => {
    const rpc = async () => ({ data: null, error: { message: 'Device is not owned by current user' } })
    await expect(publishDeviceProjects({ rpc }, 'dev-x', [])).rejects.toThrow(/not owned/)
  })
})

describe('listDeviceProjects', () => {
  /**
   * 假的 identity.device_projects:按 (设备, 项目) 排序、按 range 切页、头一页带总行数;`maxRows` = 服务端一页最多回多少行
   * (社区默认 1000,别的部署可能更少);`beforePage` 在第 n 页回答前改表(读的途中那台机器又记了一份)。
   */
  function table(initial: Record<string, unknown>[], options: { maxRows?: number; error?: string; beforePage?: (page: number, rows: Record<string, unknown>[]) => void } = {}) {
    const rows = [...initial]
    const calls: { user: string; order: string[]; from: number; to: number }[] = []
    const client = {
      from: (name: string) => {
        expect(name).toBe('device_projects')
        return {
          select: (_columns: string, opts: { count: string }) => {
            expect(opts).toEqual({ count: 'exact' })
            return {
              eq: (column: string, user: string) => {
                expect(column).toBe('user_id')
                const order: string[] = []
                let only: readonly string[] | null = null
                const page = {
                  in: (inColumn: string, ids: readonly string[]) => { expect(inColumn).toBe('device_id'); only = ids; return page },
                  order: (by: string) => (order.push(by), page),
                  range: async (from: number, to: number) => {
                    options.beforePage?.(calls.length, rows)
                    calls.push({ user, order: [...order], from, to })
                    if (options.error) return { data: null, error: { message: options.error }, count: null }
                    const sorted = rows.filter((r) => !only || only.includes(String(r.device_id))).sort((a, b) =>
                      String(a.device_id).localeCompare(String(b.device_id)) || String(a.local_project_id).localeCompare(String(b.local_project_id)))
                    const size = Math.min(to - from + 1, options.maxRows ?? Infinity)
                    return { data: sorted.slice(from, from + size), error: null, count: sorted.length }
                  },
                }
                return page
              },
            }
          },
        }
      },
    }
    return { client: client as never, calls, rows }
  }

  it('reads only the named devices when a revision names them', async () => {
    const { client } = table([row(), row({ device_id: 'dev-2', local_project_id: 'p9' })])
    expect(Object.keys(await listDeviceProjects(client, 'owner-1', ['dev-2']))).toEqual(['dev-2'])
  })

  it('groups the rows by device, newest project first, only the owner’s rows', async () => {
    const { client, calls } = table([
      row(),
      row({ local_project_id: 'p2', created_at: '2026-10-05T00:00:00+00:00', chat_id: null, group_representative: true, folders: [] }),
      row({ device_id: 'dev-2', local_project_id: 'p9' }),
    ])
    const listed = await listDeviceProjects(client, 'owner-1')
    expect(calls).toEqual([{ user: 'owner-1', order: ['device_id', 'local_project_id'], from: 0, to: DEVICE_PROJECT_PAGE_ROWS - 1 }])
    expect(Object.keys(listed).sort()).toEqual(['dev-1', 'dev-2'])
    expect(listed['dev-1']!.map((item) => item.localProjectId)).toEqual(['p2', 'p1'])
    expect(listed['dev-1']![0]).toMatchObject({ chatId: null, folders: [], createdAt: '2026-10-05T00:00:00.000Z' })
    expect(listed['dev-1']![1]).toEqual(project())
  })

  it('reads every page, ❌ stops at the first one (the server caps how many rows one request returns)', async () => {
    const many = Array.from({ length: 2500 }, (_, index) => row({ device_id: `dev-${index % 3}`, local_project_id: `p${String(index).padStart(4, '0')}` }))
    const full = table(many)
    const listed = await listDeviceProjects(full.client, 'o')
    expect(Object.values(listed).flat()).toHaveLength(2500)
    expect(full.calls.map((call) => call.from)).toEqual([0, 1000, 2000])
    // 这台服务端一页只回 400 行(比请求的少):按实际拿到的往后读,❌ 跳过中间那几百行。
    const capped = table(many, { maxRows: 400 })
    expect(Object.values(await listDeviceProjects(capped.client, 'o')).flat()).toHaveLength(2500)
    expect(capped.calls.map((call) => call.from).slice(0, 3)).toEqual([0, 400, 800])
  })

  it('a list that changes while it is read is not a list (the change will be read again)', async () => {
    const many = Array.from({ length: 1500 }, (_, index) => row({ local_project_id: `p${String(index).padStart(4, '0')}` }))
    // 读完第一页,那台机器删了一个项目:行数对不上。
    const shrank = table(many, { beforePage: (page, rows) => { if (page === 1) rows.splice(0, 1) } })
    await expect(listDeviceProjects(shrank.client, 'o')).rejects.toThrow(/changed while it was being read/)
  })

  it('refuses to list without an owner, and fails as a whole on a row it cannot read (❌ quietly lists one project less)', async () => {
    await expect(listDeviceProjects(table([]).client, '')).rejects.toThrow(/ownerId/)
    await expect(listDeviceProjects(table([], { error: 'permission denied' }).client, 'o')).rejects.toThrow(/permission denied/)
    await expect(listDeviceProjects(table([row({ folders: 'x' })]).client, 'o')).rejects.toThrow(/folder list/)
    // 对照:空账号读得到,是空的。
    await expect(listDeviceProjects(table([]).client, 'o')).resolves.toEqual({})
  })

  it('reads a row strictly: every field the machine wrote must be there', () => {
    expect(() => normalizeDeviceProjectRow(row({ root_path: '' }))).toThrow(/root_path/)
    expect(() => normalizeDeviceProjectRow(row({ created_at: 'soon' }))).toThrow(/created_at/)
    expect(() => normalizeDeviceProjectRow(row({ folders: [{ workspace_id: 'w', kind: 'other', path: '/x' }] }))).toThrow(/kind/)
    expect(() => normalizeDeviceProjectRow(row({ name: null }))).toThrow(/name/)
    // 名字可以是空串(那台机器上就叫这个)。
    expect(normalizeDeviceProjectRow(row({ name: '' })).project.name).toBe('')
  })
})

describe('withDeviceProjects', () => {
  const devices = [{ device_id: 'dev-1' }, { device_id: 'dev-2' }]

  it('a fresh read: every device gets its projects, a device with none gets an empty list', () => {
    expect(withDeviceProjects(devices, { 'dev-1': [project()] }, [])).toEqual([
      { device_id: 'dev-1', projects: [project()] },
      { device_id: 'dev-2', projects: [] },
    ])
  })

  it('a failed read keeps what each device had; a device never read stays without it', () => {
    const previous = [{ device_id: 'dev-1', projects: [project()] }]
    expect(withDeviceProjects(devices, null, previous)).toEqual([{ device_id: 'dev-1', projects: [project()] }, { device_id: 'dev-2' }])
  })
})
