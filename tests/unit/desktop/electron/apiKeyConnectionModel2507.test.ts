// #2507 第 3 步:「走模型注入」的 API Key 连接(pi / opencode / CodeBuddy)。
//  · 落成的启动值与平台会话同形,却一格都不像平台会话:没签令牌、没有中转环境、地址原样;
//  · 平台钩子只在「不上平台」时才问连接:选了咕咕的模型 ⇒ 平台那份逐字不变,连接一眼都不看;
//  · 连接那条路上没有签发(不铸令牌)、没有持有记录(不续期 / 不结算)、没有凭据目标。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listAgents = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const loadEngine = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const resolveAgentModelLaunch = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAgents: (...args: unknown[]) => listAgents(...args),
}))
vi.mock('../../../../apps/desktop/electron/acp-engine-utils', () => ({
  loadEngine: (...args: unknown[]) => loadEngine(...args),
}))
vi.mock('../../../../apps/desktop/electron/model-access', async (importOriginal) => ({
  ModelAccessHttpError: (await importOriginal<Record<string, unknown>>()).ModelAccessHttpError,
  modelAccessFailureReason: (await importOriginal<Record<string, unknown>>()).modelAccessFailureReason,
  checkpointPlatformModelAccess: async () => undefined,
  issuePlatformModelAccess: async () => { throw new Error('not expected in this test') },
  resolveAgentModelLaunch: (...args: unknown[]) => resolveAgentModelLaunch(...args),
  revokePlatformModelAccess: async () => undefined,
  renewPlatformModelAccess: async () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  markPlatformAccessDetached: async () => undefined,
  settleAdoptedPlatformAccessAtExit: async () => undefined,
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessions/getSessions', () => ({
  getSessions: async () => [],
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  SESSION_CACHE_KEY: 'emdash_session_id',
  awaitSessionpageCloudIdentity: async () => undefined,
  provisionSessionpageAgentForSession: async () => null,
}))
vi.mock('../../../../apps/desktop/electron/capability-report-store', () => ({
  noteHostInjectedModel: async () => undefined,
}))

const {
  heldPlatformModelForSession,
  releasePlatformModelForSession,
  resetPlatformRelayPersistenceForTest,
  sessionBundleModelFor,
} = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-model')
const { createSessionpagePlatformHooks } = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-hooks')
const { connectionModelLaunch, notOnPlatform } = await import('../../../../apps/desktop/electron/sessionpage/connection-model-launch')

const SESSION = 'conv-2507'
const ENDPOINT = 'https://gateway.example/api/v1'
const KEY = 'sk-user-connection'
const authProvider = {
  getAuth: async () => ({ accessToken: 't', refreshToken: null, userId: 'owner-1' }),
} as never

function platformLaunch(engine: string, model: string) {
  listAgents.mockResolvedValue([{ gugu_user_id: 'agent-1', cache: { emdash_session_id: SESSION } }])
  loadEngine.mockResolvedValue({ id: engine })
  resolveAgentModelLaunch.mockResolvedValue({
    selection: { source: 'platform', modelId: model, protocol: 'openai-responses' },
    model,
    env: { OPENAI_BASE_URL: 'https://relay.example/v1', OPENAI_API_KEY: 'sk-session' },
    access: {
      accessSessionId: 'sess-platform',
      relayUrl: 'https://relay.example',
      token: 'sk-session',
      model,
      modelId: model,
      protocol: 'openai-responses',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      contextWindow: 200_000,
      reasoningEfforts: null,
      switchableModels: [], membershipLocked: [],
      callableRoutes: {},
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GUGU_HOME', mkdtempSync(join(tmpdir(), 'gugu-2507-')))
})
afterEach(async () => {
  await releasePlatformModelForSession(SESSION).catch(() => undefined)
  vi.unstubAllEnvs()
})
afterAll(() => resetPlatformRelayPersistenceForTest())

describe('connectionModelLaunch: a connection in the platform launch shape, never a platform session', () => {
  it.each(['pi', 'opencode', 'codebuddy'])('%s: the connection address/key/model, no token, no relay env, address verbatim', (providerId) => {
    for (const surface of ['cui', 'tui'] as const) {
      const launch = connectionModelLaunch({ providerId, surface, endpoint: ENDPOINT, apiKey: KEY, model: 'user-model' })
      expect(launch).toMatchObject({ accessSessionId: null, expiresAt: null, env: {}, model: null, clientArgs: [], settingsDocumentPath: null })
      // 平台中转补 `/v1`;一把连接的地址就是用户填的那个,❌ 补。
      expect(launch.platformProvider).toEqual({ baseUrl: ENDPOINT, apiKey: KEY })
      expect(launch.modelCapability).toMatchObject({ model: 'user-model', platformProvider: { baseUrl: ENDPOINT, apiKey: KEY } })
      expect(launch.modelCapability?.contextWindow).toBeUndefined()
      expect(notOnPlatform(launch)).toBe(false)
    }
  })

  it('reaches each agent through the same channel its platform model uses', () => {
    // pi / CodeBuddy:模型走这一家自己的配置文件 ⇒ 宿主一个键都不发,声明整份进会话包。
    for (const providerId of ['pi', 'codebuddy']) {
      const launch = connectionModelLaunch({ providerId, surface: 'cui', endpoint: ENDPOINT, apiKey: KEY, model: 'user-model' })
      expect(launch.spawnEnv, providerId).toEqual({})
      expect(sessionBundleModelFor(providerId, 'acp', launch), providerId).toBe(launch.modelCapability)
      expect(sessionBundleModelFor(providerId, 'tui', launch), providerId).toBe(launch.modelCapability)
    }
    // opencode:模型走它的进程配置文档 ⇒ 那份文档在 spawnEnv 里,会话包里不再放一份。
    const opencode = connectionModelLaunch({ providerId: 'opencode', surface: 'cui', endpoint: ENDPOINT, apiKey: KEY, model: 'user-model' })
    const document = JSON.parse(opencode.spawnEnv.OPENCODE_CONFIG_CONTENT!)
    expect(document.provider['gugu-platform'].options).toEqual({ baseURL: ENDPOINT, apiKey: KEY })
    expect(document.model).toBe('gugu-platform/user-model')
    expect(sessionBundleModelFor('opencode', 'acp', opencode)).toBeNull()
  })

  it('refuses an agent with no platform model writer', () => {
    expect(() => connectionModelLaunch({ providerId: 'kiro', surface: 'cui', endpoint: ENDPOINT, apiKey: KEY, model: 'm' }))
      .toThrow(/platform model writer/)
  })
})

describe('platform hooks: the connection only where the session is not on platform', () => {
  const connection = (providerId: string, surface: 'cui' | 'tui') =>
    connectionModelLaunch({ providerId, surface, endpoint: ENDPOINT, apiKey: KEY, model: 'user-model' })

  function hooks(connectionModel?: (input: { providerId: string; surface: 'cui' | 'tui' }) => Promise<ReturnType<typeof connectionModelLaunch> | null>) {
    return createSessionpagePlatformHooks({
      authProvider: () => authProvider,
      provisionDeps: {} as never,
      env: process.env,
      ...(connectionModel ? { connectionModel } : {}),
    })
  }
  const acpInfo = (platformModel: { modelId: string } | null) => ({
    sessionId: SESSION,
    projectId: 'project-1',
    providerId: 'pi',
    cwd: '/work',
    platformModel,
  })
  const ptyInfo = (platformModel: { modelId: string } | null) => ({
    sessionId: SESSION,
    projectId: 'project-1',
    providerId: 'pi',
    cwd: '/work',
    start: 'fresh',
    platformModel,
  }) as never

  it('own model (not on platform): the selected connection, with no token issued and nothing held', async () => {
    const connectionModel = vi.fn(async ({ providerId, surface }: { providerId: string; surface: 'cui' | 'tui' }) => connection(providerId, surface))
    const h = hooks(connectionModel)

    const acp = await h.acpPlatformModel(acpInfo(null))
    expect(connectionModel).toHaveBeenCalledWith({ providerId: 'pi', surface: 'cui' })
    expect(acp.platformProvider).toEqual({ baseUrl: ENDPOINT, apiKey: KEY })
    expect(acp.modelCapability?.model).toBe('user-model')

    const { platform: pty, reusedHeld } = await h.ptyPlatform(ptyInfo(null))
    expect(connectionModel).toHaveBeenLastCalledWith({ providerId: 'pi', surface: 'tui' })
    expect(reusedHeld).toBe(false)
    expect(pty.modelCapability?.platformProvider).toEqual({ baseUrl: ENDPOINT, apiKey: KEY })

    // 不铸令牌、不持有、不续期:控制面一次都没问,手里没有这条会话的平台记录。
    expect(resolveAgentModelLaunch).not.toHaveBeenCalled()
    expect(heldPlatformModelForSession(SESSION)).toBeNull()
    expect(h.targetForSession(SESSION)?.credentialGeneration).toBeUndefined()
    // 信封注入器照「不上平台」处理:不发信封。
    expect(await h.acpInjector(acpInfo(null))).toBeNull()
  })

  it('a Gugu model (on platform): the platform launch, unchanged, and the connection never asked', async () => {
    platformLaunch('pi', 'glm-5.3')
    const connectionModel = vi.fn(async () => connection('pi', 'cui'))
    const withConnection = await hooks(connectionModel).acpPlatformModel(acpInfo({ modelId: 'glm-5.3' }))
    expect(connectionModel).not.toHaveBeenCalled()
    expect(withConnection.accessSessionId).toBe('sess-platform')
    expect(withConnection.modelCapability?.platformProvider?.apiKey).not.toBe(KEY)
    expect(JSON.stringify(withConnection)).not.toContain(ENDPOINT)
    await releasePlatformModelForSession(SESSION)

    // 同一份输入,宿主没装连接那一格:逐字相同(到期时刻是每次签发现算的,不比)。
    platformLaunch('pi', 'glm-5.3')
    const without = await hooks().acpPlatformModel(acpInfo({ modelId: 'glm-5.3' }))
    expect({ ...withConnection, expiresAt: null }).toEqual({ ...without, expiresAt: null })
  })

  it('native connection selected (resolver returns null): exactly as without connections', async () => {
    const h = hooks(async () => null)
    const acp = await h.acpPlatformModel(acpInfo(null))
    const plain = await hooks().acpPlatformModel(acpInfo(null))
    expect(acp).toEqual(plain)
    expect(notOnPlatform(acp)).toBe(true)
  })
})
