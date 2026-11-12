// The setup read points (#1931), through the resolver: what main writes into a new home on this computer, and what the
// window sends when it creates the assistant (the rules reach it over IPC). Byte for byte the recorded renders of the
// neutral test rules (neutral-digests.json, as the byte-identity test), from the App and from its last good copy.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
const provision = vi.hoisted(() => ({
  provisionSingleAgent: vi.fn(async () => ({ agentUserId: 'a', outcome: { member: { phase: 'completed' } } })),
  resumeSingleAgent: vi.fn(),
  getProvisionOperation: vi.fn(),
  getProvision: vi.fn(),
  assertResumeRecordOwner: vi.fn(),
  completedSingleProvisionSession: vi.fn(() => ({ agentUserId: 'a' })),
  createResumeStore: vi.fn(() => ({ list: () => [], forget: vi.fn() })),
}))
vi.mock('../../../../apps/desktop/src/lib/agentProvision', () => provision)
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ getCurrentAuthUserId: vi.fn(async () => 'owner') }))
const setup = vi.hoisted(() => ({ prepareLocalAssistantSetup: vi.fn(async () => ({ workdir: '/home/assistant', home: '/home' })) }))
vi.mock('../../../../apps/desktop/src/lib/assistantSetupPreparation', () => setup)
vi.mock('../../../../apps/desktop/src/lib/cloudComputerStore', () => ({ provisionCloudComputer: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({ contactsService: { agentLookAvatarUrl: () => 'avatar' } }))
// The language the profile records: the capture's first owner's.
vi.mock('../../../../apps/desktop/src/i18n/runtime', async importOriginal => ({
  ...await importOriginal<object>(), getLocaleSnapshot: () => ({ resolvedLocale: 'zh-CN' }),
}))
// The window's IPC: the rules channel is main's handler (assistant-home.ts) behind a structured clone, as Electron passes it.
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ipc }))

const { assistantRules, installAssistantRulesResolver } = await import('../../../../apps/desktop/electron/assistant-rules-resolver')
const { prepareLocalAssistantHome } = await import('../../../../apps/desktop/electron/assistant-home-prepare')
const { claimCloudAssistant, setUpAssistantOnThisComputer } = await import('../../../../apps/desktop/src/lib/assistantSetup')
const { provisionCloudComputer } = await import('../../../../apps/desktop/src/lib/cloudComputerStore')
const policy = await import('@gugu/core/shared/assistantPolicy')
const { claudeProjectDirName } = policy
const { fingerprint, readNeutralDigests } = await import('./capture')
const { fixtureBundle, fixtureHost, installBundle, OFFICIAL_SOURCE } = await import('./fixtureApp')

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'assistant-rules-setup-'))
  ipc.invoke.mockImplementation(async (channel: string) => {
    if (channel === 'assistant-home:rules') return structuredClone((await assistantRules().refresh()).rules)
    return { workdir: '/home/assistant', home: '/home' }
  })
})
afterEach(async () => {
  installAssistantRulesResolver(null)
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function useSource(source: 'last-good' | 'app') {
  const host = fixtureHost(join(root, 'host'), join(root, 'last-good'))
  installBundle(host.service, await fixtureBundle(join(root, 'bundle')), 'market', OFFICIAL_SOURCE('0.0.1'))
  installAssistantRulesResolver(host.resolver)
  if (source === 'last-good') {
    await host.resolver.refresh()
    host.service.uninstall('gugu-assistant')
    installAssistantRulesResolver(fixtureHost(join(root, 'host'), join(root, 'last-good')).resolver)
  }
  expect((await assistantRules().refresh()).source).toBe(source)
}

/** Each render against the recorded digests: the keys whose bytes differ. */
function differing(renders: Record<string, string>): string[] {
  const baseline = readNeutralDigests()
  return Object.entries(renders).filter(([key, value]) => fingerprint(value).sha256 !== baseline[key]!.sha256).map(([key]) => key)
}

describe.each(['app', 'last-good'] as const)('setup through the resolver, source %s', source => {
  it('main writes the home and the profile memory as recorded', async () => {
    await useSource(source)
    // The layout the capture used for `refresh/computer-claude/*`, so the same keys compare.
    const base = join(root, 'computer-claude'), home = join(base, 'home'), guguHome = join(base, 'gugu')
    await mkdir(home, { recursive: true })
    const markdown = policy.ownerProfileMarkdown({ preferredName: ' 小明 ', about: '  研究员，正在做细胞实验。\n早上 9 点开工。 ', language: 'zh-CN' }, (await assistantRules().available()).rules)
    const { workdir } = await prepareLocalAssistantHome({ ownerProfile: markdown }, { home, guguHome })
    const paths = policy.assistantHomePaths(home, workdir, 'computer')
    const scrub = (text: string) => text.split(root).join('<ROOT>').split(claudeProjectDirName(root)).join('<ROOT-DIR>')
    const settings = JSON.parse(scrub(await readFile(paths.settings, 'utf8'))) as { claudeMdExcludes: string[] }
    expect(differing({
      'refresh/computer-claude/instructions': scrub(await readFile(paths.instructions, 'utf8')),
      'refresh/computer-claude/reference': scrub(await readFile(join(workdir, '.gugu-assistant-reference.md'), 'utf8')),
      'refresh/computer-claude/settings': JSON.stringify({ ...settings, claudeMdExcludes: settings.claudeMdExcludes.filter(path => path.startsWith('<ROOT>')) }, null, 2),
      'ownerProfile/memoryFile/0': await readFile(join(paths.memoryDir, 'owner-profile.md'), 'utf8'),
      'ownerProfile/index/0': await readFile(paths.memoryIndex, 'utf8'),
    })).toEqual([])
  })

  it('the window creates the assistant with the first task, child harness and profile wording as recorded', async () => {
    await useSource(source)
    const draft = { name: 'Gugu', color: 0, rest: 'curious', owner: { preferredName: ' 小明 ', about: '  研究员，正在做细胞实验。\n早上 9 点开工。 ' } } as never
    await setUpAssistantOnThisComputer(draft, 'device-1')
    const deps = (provision.provisionSingleAgent.mock.calls[0] as unknown[])[2] as { assistant: { childHarness: string; firstTask: string } }
    const profile = ((setup.prepareLocalAssistantSetup.mock.calls[0] as unknown[])[1] as { ownerProfile: string }).ownerProfile
    await claimCloudAssistant(draft)
    const cloud = (vi.mocked(provisionCloudComputer).mock.calls[0]![0] as { assistant: { ownerProfile: string } }).assistant.ownerProfile
    expect(ipc.invoke).toHaveBeenCalledWith('assistant-home:rules')
    expect(differing({
      'defaults/childHarness': deps.assistant.childHarness,
      'text/firstTask': deps.assistant.firstTask,
      'ownerProfile/markdown/0': profile,
    })).toEqual([])
    expect(cloud).toBe(profile)
  })
})
