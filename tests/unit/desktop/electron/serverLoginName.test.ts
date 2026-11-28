import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLocalDeviceId, type ResolveLocalDeviceIdOptions } from '@gugu/core/cloud/deviceRuntime'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

const layout = vi.hoisted(() => ({ dataDir: '', writeServerConnectVia: vi.fn(), accounts: [] as ServerAccount[], checkLayout: vi.fn() }))
const devices = vi.hoisted(() => ({
  renameDevice: vi.fn(async () => undefined),
  resolveLocalDeviceId: vi.fn<(options: ResolveLocalDeviceIdOptions) => Promise<string>>(async () => 'dev-1'),
  restartServerAfterLogin: vi.fn(),
}))
const writeStoredServerSession = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ app: { getVersion: () => '0.3.0' }, safeStorage: {} }))
vi.mock('../../../../apps/desktop/electron/server/server-auth', () => ({ writeStoredServerSession }))
vi.mock('../../../../apps/desktop/electron/server/server-layout', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/electron/server/server-layout')>()
  layout.writeServerConnectVia.mockImplementation(actual.writeServerConnectVia)
  return {
    applyAccountEnv: vi.fn(),
    accountDataDir: () => layout.dataDir,
    serverHome: () => layout.dataDir,
    clearSignedOutMark: vi.fn(),
    emailFromAccessToken: () => 'me@x.y',
    readServerAccount: () => layout.accounts[0] ?? null,
    writeAccountMeta: vi.fn(),
    writeServerConnectVia: layout.writeServerConnectVia,
  }
})
vi.mock('../../../../apps/desktop/electron/server/server-boot.cjs', () => ({ prepareAccountLogin: vi.fn(), assertAccountLayoutReady: layout.checkLayout }))
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gugu/core')>()),
  resolveLocalDeviceId: devices.resolveLocalDeviceId,
  resolveServerMachineId: async () => 'machine-1',
}))
vi.mock('@gugu/core/cloud/devices', async importOriginal => ({
  ...(await importOriginal<typeof import('@gugu/core/cloud/devices')>()),
  renameDevice: devices.renameDevice,
}))
vi.mock('../../../../apps/desktop/electron/server/server-service', () => ({ restartServerAfterLogin: devices.restartServerAfterLogin }))

const saved = { ...process.env }
const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!

beforeEach(async () => {
  layout.dataDir = await mkdtemp(join(tmpdir(), 'gugu-server-login-name-'))
  process.env.GUGU_HOME = layout.dataDir
  process.env.GUGU_TASK_HOST_USER_DATA = layout.dataDir
  process.env.GUGU_SERVER_MODE = '1'
})

afterEach(async () => {
  layout.accounts = []
  layout.checkLayout.mockReset()
  process.env = { ...saved }
  Object.defineProperty(process, 'stdin', stdin)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await rm(layout.dataDir, { recursive: true, force: true })
})

const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'u1', email: 'me@x.y' })).toString('base64url')}.y`

async function login(args: string[], lines: string[] = [], rest?: (request: Request) => Promise<Response>) {
  process.env.GUGU_SUPABASE_URL = 'https://db.example.test'
  process.env.GUGU_SUPABASE_ANON_KEY = 'anon'
  Object.defineProperty(process, 'stdin', { value: Readable.from([`${'d'.repeat(43)}\n`]), configurable: true })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    if (path === '/functions/v1/server-login/poll') return Response.json({ token_hash: 'th', type: 'magiclink' })
    if (path === '/functions/v1/server-login/start') return Response.json({ device_code: 'dc', user_code: 'ABCD', expires_in: 600, interval: 0 })
    if (path === '/auth/v1/verify') return Response.json({ access_token: jwt, refresh_token: 'r' })
    if (path.startsWith('/rest/v1/') && rest) return rest(request)
    throw new Error(`Unexpected HTTP request to ${path}`)
  }))
  const { runServerLogin } = await import('../../../../apps/desktop/electron/server/server-login')
  return runServerLogin(line => lines.push(line), args)
}

describe('#6264 gugu-server login --grant-stdin --name', () => {
  it('refuses an unmigrated layout before consuming the grant or requesting tokens', async () => {
    layout.checkLayout.mockImplementation(() => { throw new Error('Run gugu-server start to migrate one@example.test') })
    expect(await login(['--grant-stdin'])).toBe(78)
    expect(fetch).not.toHaveBeenCalled()
    expect(layout.writeServerConnectVia).not.toHaveBeenCalled()
  })

  it('refuses an already signed-in installation before consuming the grant or requesting tokens', async () => {
    layout.accounts = [{ userId: 'existing', email: 'existing@example.test', signedIn: true, addedAt: null,
      dir: '', dataDir: '', homeDir: '', signedOut: null }]
    expect(await login(['--grant-stdin'])).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(layout.writeServerConnectVia).not.toHaveBeenCalled()
  })

  it('starts the server after login unless a controller owns the install', async () => {
    expect(await login(['--grant-stdin'])).toBe(0)
    expect(devices.restartServerAfterLogin).toHaveBeenCalledOnce()
    devices.restartServerAfterLogin.mockClear()
    process.env.GUGU_CLOUD_COMPUTER = '1'
    expect(await login(['--grant-stdin'])).toBe(0)
    expect(devices.restartServerAfterLogin).not.toHaveBeenCalled()
  })

  it('allows a signed-out account to authenticate again', async () => {
    layout.accounts = [{ userId: 'u1', email: 'me@x.y', signedIn: false, addedAt: null,
      dir: '', dataDir: '', homeDir: '', signedOut: null }]
    expect(await login(['--grant-stdin'])).toBe(0)
    expect(fetch).toHaveBeenCalled()
  })
  it.each([
    { previous: 'old-host.local', marker: null, expected: 'd22' },
    { previous: 'old-ssh-alias', marker: null, expected: 'd22' },
    { previous: 'Linux 2', marker: '2026-10-01T00:00:00Z', expected: 'Linux 2' },
    { previous: 'd22', marker: null, expected: 'd22' },
  ])('adopts a new alias for $previous only when the stored marker permits it', async ({ previous, marker, expected }) => {
    const row = { label: previous, label_customized_at: marker }
    const patch = vi.fn(async (request: Request) => {
      const url = new URL(request.url)
      expect([request.method, url.pathname]).toEqual(['PATCH', '/rest/v1/gugu_devices'])
      expect(Object.fromEntries(url.searchParams)).toEqual({
        device_id: 'eq.dev-1', label_customized_at: 'is.null', label: 'neq.d22', select: 'device_id',
      })
      const change = await request.json() as { label: string; label_customized_at: string; updated_at: string }
      expect(change).toEqual({ label: 'd22', label_customized_at: 'now', updated_at: 'now' })
      if (row.label_customized_at !== null || row.label === change.label) return Response.json([])
      row.label = change.label
      row.label_customized_at = 'database timestamp'
      return Response.json([{ device_id: 'dev-1' }])
    })
    expect(await login(['--grant-stdin', '--name', 'd22'], [], patch)).toBe(0)
    expect(patch).toHaveBeenCalledOnce()
    await expect(patch.mock.results[0].value).resolves.toBeInstanceOf(Response)
    expect(row).toEqual({ label: expected, label_customized_at: previous === expected ? marker : 'database timestamp' })
    expect(devices.renameDevice).not.toHaveBeenCalled()
  })

  it('reads the SSH name written by login when the real resolver reserves the device', async () => {
    devices.resolveLocalDeviceId.mockImplementationOnce(options => resolveLocalDeviceId({ ...options, machineIdentifier: () => 'machine-1' }))
    const rest = vi.fn(async (request: Request) => {
      const url = new URL(request.url)
      if (url.pathname === '/rest/v1/rpc/register_gugu_device') {
        const saved = JSON.parse(await readFile(join(layout.dataDir, 'connect-via.json'), 'utf8'))
        expect(saved).toMatchObject({ via: 'ssh', name: 'fresh-alias' })
        expect(await request.json()).toMatchObject({ p_device: { label: 'fresh-alias', reserve_only: true } })
        return Response.json({ device_id: 'dev-1', created: true })
      }
      expect([request.method, url.pathname, url.searchParams.get('label')]).toEqual(['PATCH', '/rest/v1/gugu_devices', 'neq.fresh-alias'])
      return Response.json([])
    })
    const lines: string[] = []
    expect(await login(['--grant-stdin', '--name', 'fresh-alias'], lines, rest)).toBe(0)
    expect(rest).toHaveBeenCalledTimes(2)
    await expect(rest.mock.results[1].value).resolves.toBeInstanceOf(Response)
    expect(lines.find(line => line.startsWith('__GUGU_LOGIN_RESULT__'))).toContain('"deviceId":"dev-1"')
    expect(devices.renameDevice).not.toHaveBeenCalled()
  })

  it('没带名字(老桌面):照旧登录,不记名字、不改名', async () => {
    expect(await login(['--grant-stdin'])).toBe(0)
    expect(layout.writeServerConnectVia).toHaveBeenCalledWith(layout.dataDir, 'ssh', { name: null })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('gugu-server login --name(链接 + 短码那条路)', () => {
  it('renames the reserved device before publishing the session, regardless of its old label', async () => {
    expect(await login(['--name', ' Research runner '])).toBe(0)
    expect(layout.writeServerConnectVia).toHaveBeenCalledWith(layout.dataDir, 'tunnel', { name: 'Research runner' })
    expect(devices.renameDevice).toHaveBeenCalledWith(expect.anything(), 'dev-1', 'Research runner')
    expect(devices.renameDevice).toHaveBeenCalledBefore(writeStoredServerSession)
  })

  it.each([
    ['resolveLocalDeviceId', '无法登记设备：device write refused'],
    ['renameDevice', '无法设置设备名 "Research runner"：device write refused'],
  ] as const)('reports %s failure and leaves login retryable', async (operation, message) => {
    devices[operation].mockRejectedValueOnce(new Error('device write refused'))
    const lines: string[] = []
    expect(await login(['--name', 'Research runner'], lines)).toBe(1)
    expect(lines.at(-1)).toContain(message)
    if (operation === 'resolveLocalDeviceId') expect(devices.renameDevice).not.toHaveBeenCalled()
    expect(writeStoredServerSession).not.toHaveBeenCalled()
    expect(devices.restartServerAfterLogin).not.toHaveBeenCalled()
  })

  it('leaves naming to the server heartbeat when no name is supplied', async () => {
    expect(await login([])).toBe(0)
    expect(layout.writeServerConnectVia).toHaveBeenCalledWith(layout.dataDir, 'tunnel', { name: null })
    expect(devices.resolveLocalDeviceId).not.toHaveBeenCalled()
    expect(devices.renameDevice).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'blank', args: ['--name', ' '] },
    { kind: 'missing', args: ['--name'] },
    { kind: 'followed by an option', args: ['--name', '--json'] },
  ])('rejects a name that is $kind before requesting authorization', async ({ args }) => {
    const lines: string[] = []
    expect(await login(args, lines)).toBe(2)
    expect(lines).toEqual(['请在 --name 后填写设备名。以 -- 开头的参数用于命令选项。'])
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'Unicode', name: '研究节点🌿' },
    { kind: '4096-character', name: 'a'.repeat(4096) },
  ])('passes a $kind name through to the rename RPC without truncation', async ({ name }) => {
    expect(await login(['--name', name])).toBe(0)
    expect(devices.renameDevice).toHaveBeenCalledWith(expect.anything(), 'dev-1', name)
  })
})
