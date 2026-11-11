import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantPanelItem, AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import { answerPhoneBinding, createPhoneBindings, type PhoneBindingPorts, type PhoneInstalledApp, type PhonePickedFile } from '../../../../apps/desktop/src/components/appSlot/phoneAppBindings'
import type { AppSurfaceIntent } from '../../../../apps/desktop/src/session/shared/extensions/unread-binding'
import { ASSISTANT_APP_ID, assistantLayerEntry, type AssistantAppInstall } from '../../../../apps/desktop/src/session/shared/extensions/assistant-entry'
import { PHONE_ASSISTANT_SCREENS, PHONE_BINDING_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/phone-binding'
import { APP_PLATFORMS_API_VERSION, appPlatformProblems } from '../../../../apps/desktop/src/session/shared/extensions/app-platforms'
import { EXTENSION_API_VERSION, parseExtensionManifest, safeParseExtensionManifest, type ExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { ASSISTANT_SCREENS, type AppAssistantStatus } from '../../../../apps/desktop/src/session/shared/extensions/assistant-binding'
import type { PushedWorkLedger } from '../../../../apps/desktop/src/session/shared/extensions/work-binding'
import type { PhoneLayerActions, PhoneLayerShown, PhoneLayerStatus } from '../../../../apps/desktop/src/components/appSlot/phoneAssistantLayer'

/**
 * API 49: the conversation binding on a phone. The host binds only the product's assistant App to the account's private chat
 * with its own assistant; every refusal fails closed; what has no phone meaning answers `unsupported`; the page is told the
 * phone layout and the section it fills.
 */

const OWNER = '0a000000-0000-4000-8000-000000000048'
const OTHER = '0b000000-0000-4000-8000-000000000048'
const AGENT = '0c000000-0000-4000-8000-000000000048'
const STRANGER = '0d000000-0000-4000-8000-000000000048'
const CHAT = '0e000000-0000-4000-8000-000000000048'
const DEVICE = '0f000000-0000-4000-8000-000000000048'
const SCHEDULE = '1a000000-0000-4000-8000-000000000048'
const WORK = '2a000000-0000-4000-8000-000000000048'

const ALL_CAPABILITIES = ['chat:unread', 'chat:files', 'chat:draft', 'chat:surface', 'chat:resources', 'chat:resources:write',
  'chat:schedules', 'chat:schedules:control', 'assistant:status', 'assistant:open', 'assistant:rename', 'chat:work'] as const
function assistantManifest(overrides: Record<string, unknown> = {}): ExtensionManifest {
  return parseExtensionManifest({
    id: ASSISTANT_APP_ID, name: 'Assistant', version: '1.0.0', apiVersion: PHONE_BINDING_API_VERSION, defaultLocale: 'en', platforms: ['desktop', 'phone'],
    entry: 'index.html',
    permissions: {
      capabilities: [...ALL_CAPABILITIES],
      bindings: [{
        name: 'main', kind: 'conversation',
        actions: ['unread', 'files', 'draft', 'surface', 'resources', 'resources:write', 'schedules', 'schedules:control', 'assistant-status', 'assistant-open', 'assistant-rename', 'work'],
        domains: { resources: ['memory', 'files', 'voice-notes'], 'resources:write': ['memory'] },
      }],
    },
    contributes: { tabs: [{ name: 'panel', title: 'Assistant' }], conversationSurface: { binding: 'main', placement: 'side-panel' } },
    ...overrides,
  })
}
function install(overrides: Partial<PhoneInstalledApp> = {}): PhoneInstalledApp {
  return {
    manifest: assistantManifest(), origin: 'market', marketSource: { repo: 'GUYI-AI/gugu-apps', path: `releases/${ASSISTANT_APP_ID}/1.0.0` }, manifestDigest: 'd1',
    activeVariant: 'upstream', enabled: true, mainTabKind: `${ASSISTANT_APP_ID}.panel`, ...overrides,
  }
}

const panelItem = (domain: AssistantPanelItem['domain'], key: string, data: Record<string, unknown>, revision = '3'): AssistantPanelItem => ({
  assistant_user_id: AGENT, owner_user_id: OWNER, domain, resource_key: key, device_id: null, revision, data,
  body_item_id: null, body_sha256: null, deleted_at: null, observed_at: null, updated_at: '2026-11-11T10:00:00.000Z',
})

type World = {
  account: { token: string; ownerId: string } | null
  app: PhoneInstalledApp | null
  assistant: { agentId: string; chatId: string; deviceId: string } | null | 'fails'
  conversation: { kind: string | null; members: string[] }
  resourceChat: string
  shown: PhoneLayerShown | null
  status: PhoneLayerStatus | null
  work: PushedWorkLedger | null
  openWork: { ownerId: string; workId: string; sessionId: string } | null
  snapshot: AssistantPanelSnapshot
  /** Runs inside the next wait: the world changing under a call. */
  during: (() => void) | null
  /** What the phone's picker gives (null: cancelled). */
  picked: PhonePickedFile[] | null
}
let world: World
const actions = { move: vi.fn(), open: vi.fn(), openWork: vi.fn(), rename: vi.fn(async (_agentId: string, _name: string) => undefined),
  confirmRemoval: vi.fn(async (_question: { kind: 'voice-note'; title: string | null }) => true) } satisfies PhoneLayerActions
const intentListeners = new Set<(intent: AppSurfaceIntent) => void>()
const drafted: { chatId: string; text: string }[] = []
const commits: unknown[] = []

function ports(): PhoneBindingPorts {
  const wait = async <T>(value: () => T): Promise<T> => {
    await Promise.resolve()
    const during = world.during
    world.during = null
    during?.()
    return value()
  }
  return {
    account: () => world.account,
    installed: (id) => (world.app?.manifest.id === id ? world.app : null),
    personalAssistant: () => wait(() => {
      if (world.assistant === 'fails') throw Object.assign(new Error('down'), { code: 'failed' })
      return world.assistant
    }),
    conversation: () => wait(() => world.conversation),
    files: {
      list: () => wait(() => [{ name: 'today.json', path: 'today.json', type: 'file', contentType: 'application/json', size: 2, version: 1, createdAt: 't', updatedAt: 't', chat: CHAT, id: 'item-secret', creator: 'someone' } as never]),
      read: () => wait(() => ({ state: 'ready' as const, entry: { name: 'today.json', path: 'today.json', type: 'file', contentType: 'application/json', size: 2, version: 1, createdAt: 't', updatedAt: 't', id: 'item-secret' } as never, content: '{}', truncated: false, totalSize: 2 })),
      resourceChat: () => wait(() => world.resourceChat),
    },
    draft: async (chatId, text) => { drafted.push({ chatId, text }) },
    renameAssistant: (agentId, name) => actions.rename(agentId, name),
    pickFiles: () => wait(() => world.picked),
    confirmRemoval: (question) => actions.confirmRemoval(question),
    panel: {
      client: {
        snapshot: async () => world.snapshot,
        resource: async () => null,
        commit: async (_agent: string, change: { operationId: string; expectedRevision: string }) => {
          commits.push(change)
          return { operationId: change.operationId, revision: '4', status: 'pending' as const }
        },
      } as never,
      snapshot: () => wait(() => world.snapshot),
      resource: () => wait(() => null),
      commit: async (_owner, _agent, change) => {
        commits.push(change)
        return { operationId: change.operationId, revision: '5', status: 'pending' }
      },
      readBody: async () => new Uint8Array(),
      uploadBody: async () => ({ itemId: 'body', sha256: 'a'.repeat(64) }),
      discard: async () => undefined,
      subscribe: () => () => undefined,
    },
    layer: {
      shown: () => world.shown,
      onShown: () => () => undefined,
      actions: () => actions,
      status: () => world.status,
      onStatus: () => () => undefined,
      work: () => world.work,
      openWork: () => world.openWork,
      onWork: () => () => undefined,
      onIntent: (listener) => {
        intentListeners.add(listener)
        return () => { intentListeners.delete(listener) }
      },
    },
    randomUUID: () => crypto.randomUUID(),
    sha256: async () => 'b'.repeat(64),
  }
}
const FOUND: AppAssistantStatus = {
  assistant: 'found', name: 'Pip', avatar: null, tint: 40, home: { kind: 'cloud', online: true, label: null }, setup: null, preparing: false,
  cloudAvailable: true, member: null, loadError: null, ownerName: 'Ann', counts: null, connectors: null, nameMax: 30,
}

beforeEach(() => {
  world = {
    account: { token: 't', ownerId: OWNER }, app: install(), assistant: { agentId: AGENT, chatId: CHAT, deviceId: DEVICE },
    conversation: { kind: 'dm', members: [OWNER, AGENT] }, resourceChat: CHAT,
    shown: { ownerId: OWNER, extensionId: ASSISTANT_APP_ID, tabId: 'assistant-layer', section: 'today', hostPage: false },
    status: { ownerId: OWNER, status: FOUND }, work: null, openWork: null,
    snapshot: { version: 1, revision: '9', items: [panelItem('memory', '__collection__', { state: 'ready' }), panelItem('memory', 'notes/a.md', { title: 'A', relativePath: 'notes/a.md', secret: 'x' })], application: [] },
    during: null,
    picked: null,
  }
  intentListeners.clear()
  actions.confirmRemoval.mockReset()
  actions.confirmRemoval.mockImplementation(async () => true)
  actions.move.mockReset()
  actions.open.mockReset()
  actions.openWork.mockReset()
  actions.rename.mockReset()
  drafted.length = 0
  commits.length = 0
})
const PAGE = { extensionId: ASSISTANT_APP_ID, tabId: 'assistant-layer', pageId: 1 }
const codeOf = async (promise: Promise<unknown>) => promise.then(() => 'resolved', (error: { code?: string }) => error.code)

describe('the assistant\'s place: App or built-in (assistantLayerEntry)', () => {
  const entry = (overrides: Partial<AssistantAppInstall> | null) => assistantLayerEntry(overrides === null ? null : install(overrides as Partial<PhoneInstalledApp>), 'phone')
  it('is the App only for the trusted official App with everything the layer needs', () => {
    expect(entry({})).toEqual({ entry: 'app', extensionId: ASSISTANT_APP_ID, tabKind: `${ASSISTANT_APP_ID}.panel`, binding: 'main' })
    expect(entry({ marketSource: { repo: 'shuxueshuxue/gugu-apps', path: `releases/${ASSISTANT_APP_ID}/1.0.0` } }).entry).toBe('app')
  })
  it.each([
    ['not installed', null, /not installed/],
    ['another App', { manifest: assistantManifest({ id: 'look-alike' }) }, /not gugu-assistant/],
    ['from a chat', { origin: 'attachment' }, /not the market/],
    ['no market record', { marketSource: null }, /no record/],
    ['someone else\'s repository', { marketSource: { repo: 'evil/gugu-apps', path: `releases/${ASSISTANT_APP_ID}/1.0.0` } }, /evil\/gugu-apps/],
    ['not its signed release folder', { marketSource: { repo: 'GUYI-AI/gugu-apps', path: `sources/${ASSISTANT_APP_ID}` } }, /signed release folder/],
    ['another version\'s release folder', { marketSource: { repo: 'GUYI-AI/gugu-apps', path: `releases/${ASSISTANT_APP_ID}/0.9.0` } }, /signed release folder/],
    ['a fork in use', { activeVariant: 'mine' }, /fork/],
    ['switched off', { enabled: false }, /switched off/],
    ['no phone', { manifest: assistantManifest({ platforms: ['desktop'] }) }, /does not declare phone/],
    ['no main page', { mainTabKind: null }, /no main page/],
  ] as const)('is built-in when %s', (_case, overrides, reason) => {
    const result = entry(overrides as Partial<AssistantAppInstall> | null)
    expect(result.entry).toBe('built-in')
    expect((result as { reason: string }).reason).toMatch(reason)
  })
  it('is built-in when the surface or its grant is missing, or the binding predates the phone', () => {
    const base = assistantManifest()
    const noGrant = { ...base, permissions: { ...base.permissions, capabilities: base.permissions!.capabilities!.filter((c) => c !== 'chat:surface') } }
    expect(entry({ manifest: noGrant as ExtensionManifest }).entry).toBe('built-in')
    const noSurface = { ...base, contributes: { ...base.contributes, conversationSurface: undefined } }
    expect(entry({ manifest: noSurface as ExtensionManifest }).entry).toBe('built-in')
    expect(entry({ manifest: { ...base, apiVersion: PHONE_BINDING_API_VERSION - 1 } }).entry).toBe('built-in')
  })
})

describe('the manifest and the phone (API 49)', () => {
  it('takes a binding on a phone from apiVersion 49 and refuses it before', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(PHONE_BINDING_API_VERSION)
    expect(safeParseExtensionManifest(assistantManifest()).ok).toBe(true)
    const older = safeParseExtensionManifest({ ...assistantManifest(), apiVersion: 48 })
    expect(older.ok).toBe(false)
    expect(JSON.stringify(older)).toMatch(/on a phone requires apiVersion 49/)
  })
  it('lets a phone App declare every binding capability (publication and install check)', () => {
    expect(appPlatformProblems(assistantManifest())).toEqual([])
    expect(APP_PLATFORMS_API_VERSION).toBeLessThan(PHONE_BINDING_API_VERSION)
  })
})

describe('the binding on a phone: who is asked, every refusal', () => {
  it('binds the trusted App to the account\'s private chat with its assistant, by an opaque handle', async () => {
    const bindings = createPhoneBindings(ports())
    const got = await bindings.get(ASSISTANT_APP_ID, { name: 'main' })
    expect(got).toMatchObject({ name: 'main', state: 'bound' })
    expect(JSON.stringify(got)).not.toContain(CHAT)
    expect(JSON.stringify(got)).not.toContain(AGENT)
    expect((await bindings.get(ASSISTANT_APP_ID, { name: 'main' }) as { handle: string }).handle).toBe((got as { handle: string }).handle)
  })
  it('refuses with nobody signed in', async () => {
    world.account = null
    expect(await codeOf(createPhoneBindings(ports()).list(ASSISTANT_APP_ID, { name: 'main' }))).toBe('denied')
  })
  it('refuses an App that is not installed, switched off, or lacks the action\'s grant', async () => {
    const bindings = createPhoneBindings(ports())
    expect(await codeOf(bindings.list('other-app', { name: 'main' }))).toBe('denied')
    world.app = install({ enabled: false })
    expect(await codeOf(bindings.list(ASSISTANT_APP_ID, { name: 'main' }))).toBe('denied')
    const base = assistantManifest()
    world.app = install({ manifest: { ...base, permissions: { ...base.permissions, capabilities: base.permissions!.capabilities!.filter((c) => c !== 'chat:files') } } as ExtensionManifest })
    expect(await codeOf(bindings.list(ASSISTANT_APP_ID, { name: 'main' }))).toBe('denied')
    world.app = install()
    expect(await codeOf(bindings.list(ASSISTANT_APP_ID, { name: 'other' }))).toBe('denied')
  })
  it('leaves an untrusted App unbound on a phone: no picker, no other chat', async () => {
    world.app = install({ origin: 'attachment' })
    const bindings = createPhoneBindings(ports())
    expect(await bindings.get(ASSISTANT_APP_ID, { name: 'main' })).toMatchObject({ state: 'unbound' })
    expect(await bindings.list(ASSISTANT_APP_ID, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' })
    expect(await codeOf(bindings.draft(ASSISTANT_APP_ID, { text: 'hi', draft: true, to: { binding: 'main' } }))).toBe('not-found')
    expect(drafted).toEqual([])
  })
  it('is unbound while the account has no assistant ready, and unavailable when that cannot be told', async () => {
    world.assistant = null
    const bindings = createPhoneBindings(ports())
    expect(await bindings.list(ASSISTANT_APP_ID, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' })
    world.assistant = 'fails'
    expect(await bindings.list(ASSISTANT_APP_ID, { name: 'main' })).toEqual({ name: 'main', state: 'unavailable' })
  })
  it.each([
    ['a group', { kind: 'group', members: [OWNER, AGENT] }],
    ['a DM of three', { kind: 'dm', members: [OWNER, AGENT, STRANGER] }],
    ['a DM with another agent', { kind: 'dm', members: [OWNER, STRANGER] }],
    ['a DM the account left', { kind: 'dm', members: [AGENT, STRANGER] }],
  ])('refuses when the provision\'s chat is %s', async (_case, conversation) => {
    world.conversation = conversation
    expect(await codeOf(createPhoneBindings(ports()).list(ASSISTANT_APP_ID, { name: 'main' }))).toBe('denied')
  })
  it('refuses when the account changes during a wait', async () => {
    world.during = () => { world.account = { token: 't2', ownerId: OTHER } }
    expect(await codeOf(createPhoneBindings(ports()).read(ASSISTANT_APP_ID, { name: 'main', path: 'today.json' }))).toBe('denied')
  })
  it('refuses when the App is updated, switched off or uninstalled during a wait', async () => {
    for (const change of [() => { world.app = install({ manifestDigest: 'd2' }) }, () => { world.app = install({ enabled: false }) }, () => { world.app = null }]) {
      world.during = change
      world.app = install()
      expect(await codeOf(createPhoneBindings(ports()).list(ASSISTANT_APP_ID, { name: 'main' }))).toBe('denied')
    }
  })
  it('reads only a chat keeping its own folder, by paths, and gives no id', async () => {
    const bindings = createPhoneBindings(ports())
    const listed = await bindings.list(ASSISTANT_APP_ID, { name: 'main' })
    expect(listed).toMatchObject({ state: 'ready', entries: [{ name: 'today.json', path: 'today.json' }] })
    expect(JSON.stringify(listed)).not.toMatch(/item-secret|someone|0e000000/)
    const read = await bindings.read(ASSISTANT_APP_ID, { name: 'main', path: 'today.json' })
    expect(read).toMatchObject({ state: 'ready', content: '{}' })
    expect(JSON.stringify(read)).not.toContain('item-secret')
    expect(await codeOf(bindings.read(ASSISTANT_APP_ID, { name: 'main', path: '../x' }))).toBe('invalid')
    expect(await codeOf(bindings.read(ASSISTANT_APP_ID, { name: 'main', path: 'a', chat: CHAT }))).toBe('invalid')
    world.resourceChat = STRANGER
    expect(await codeOf(bindings.list(ASSISTANT_APP_ID, { name: 'main' }))).toBe('denied')
  })
  it('puts a draft in the bound chat\'s composer and sends nothing', async () => {
    expect(await createPhoneBindings(ports()).draft(ASSISTANT_APP_ID, { text: 'hi', draft: true, to: { binding: 'main' } })).toEqual({ to: { binding: 'main' } })
    expect(drafted).toEqual([{ chatId: CHAT, text: 'hi\n' }])
    expect(await codeOf(createPhoneBindings(ports()).draft(ASSISTANT_APP_ID, { text: 'hi', to: { binding: 'main' } }))).toBe('invalid')
  })
  it('answers a draft carrying files (50) unsupported and places nothing — never the text without them', async () => {
    const answer = await createPhoneBindings(ports()).draft(ASSISTANT_APP_ID, { text: 'see', draft: true, to: { binding: 'main' }, attach: [{ file: 'today.json' }] })
    expect(answer).toEqual({ name: 'main', state: 'unsupported' })
    expect(drafted).toEqual([])
  })
})

describe('API 50 on a phone: what the built-in pages did is done there, the rest answers unsupported', () => {
  const base = assistantManifest()
  const binding = base.permissions!.bindings![0]!
  // At most the catalog's capabilities: voice-note managing in place of rename here.
  const withManage = () => install({ manifest: assistantManifest({ apiVersion: 50, permissions: { ...base.permissions,
    capabilities: [...base.permissions!.capabilities!.filter((c) => c !== 'assistant:rename'), 'chat:voice-notes:manage'],
    bindings: [{ ...binding, actions: [...binding.actions.filter((a) => a !== 'assistant-rename'), 'voice-notes:manage'],
      domains: { resources: ['memory', 'files', 'voice-notes'], 'resources:write': ['memory', 'files'] } }] } }) })
  const picked = (name: string, size = 3, contentType = 'text/plain'): PhonePickedFile => ({ name, size, contentType, read: async () => new TextEncoder().encode('abc') })
  const withVoiceNote = () => {
    world.snapshot = { ...world.snapshot, items: [...world.snapshot.items, panelItem('voice-notes', '__collection__', { state: 'ready' }),
      panelItem('voice-notes', 'n1', { noteId: 'n1', kind: 'directory' }), panelItem('voice-notes', 'n1/note.json', { noteId: 'n1', kind: 'note.json' })] }
  }

  it.each([
    ['bindingsCreateFolder', { name: 'main', key: 'docs' }, 'resources'],
    ['bindingsRename', { name: 'main', key: 'a.md', to: 'b.md' }, 'resources'], ['bindingsRemoveFolder', { name: 'main', key: 'docs' }, 'resources'],
    ['bindingsTranscribeVoiceNote', { name: 'main', key: 'n1' }, 'voice'], ['bindingsExportVoiceNote', { name: 'main', key: 'n1' }, 'voice'],
  ] as const)('%s (the built-in phone pages never had it): unsupported once its arguments and grant hold; nothing asked or changed', async (method, args, needs) => {
    world.app = withManage()
    const bindings = createPhoneBindings(ports())
    expect(await answerPhoneBinding(bindings, method, PAGE, { ...args }, () => undefined)).toEqual({ name: 'main', state: 'unsupported' })
    expect(await codeOf(answerPhoneBinding(bindings, method, PAGE, { ...args, name: 'other' }, () => undefined)!)).toBe('denied')
    expect(await codeOf(answerPhoneBinding(bindings, method, PAGE, { ...args, extra: 1 }, () => undefined)!)).toBe('invalid')
    // Without the grant it needs (files writable, or voice-note managing): refused, not unsupported.
    world.app = needs === 'resources' ? install() : install({ manifest: assistantManifest() })
    expect(await codeOf(answerPhoneBinding(bindings, method, PAGE, { ...args }, () => undefined)!)).toBe('denied')
    expect(commits).toEqual([])
    expect(actions.confirmRemoval).not.toHaveBeenCalled()
  })

  it('upload: the phone\'s picker, the built-in page\'s rules, each file written into 给助理的资料 as that page wrote it', async () => {
    world.app = withManage()
    world.picked = [picked('a.md'), picked('film.mp4', 3, 'video/mp4'), picked('big.pdf', 60 * 1024 * 1024, 'application/pdf')]
    const answer = await answerPhoneBinding(createPhoneBindings(ports()), 'bindingsUpload', PAGE, { name: 'main', folder: 'docs' }, () => undefined)
    expect(answer).toEqual({ name: 'main', state: 'done',
      uploaded: [{ key: 'docs/a.md', name: 'a.md', receipt: { operationId: expect.any(String), revision: '4', status: 'pending' } }],
      refused: [{ name: 'film.mp4', why: 'unsupported' }, { name: 'big.pdf', why: 'too-large' }] })
    expect(commits).toEqual([expect.objectContaining({ domain: 'files', key: 'docs/a.md', operation: 'save', data: expect.objectContaining({ path: 'docs/a.md', kind: 'file' }) })])
  })

  it('upload: cancelled picks nothing; refused at API 49, without files writable, for another binding, an account switched while picking', async () => {
    world.app = withManage()
    const bindings = createPhoneBindings(ports())
    expect(await bindings.manage(ASSISTANT_APP_ID, 'bindingsUpload', { name: 'main' })).toEqual({ name: 'main', state: 'cancelled' })
    expect(await codeOf(bindings.manage(ASSISTANT_APP_ID, 'bindingsUpload', { name: 'main', folder: '../x' }))).toBe('invalid')
    expect(await codeOf(bindings.manage(ASSISTANT_APP_ID, 'bindingsUpload', { name: 'other' }))).toBe('denied')
    // The account switched while the picker was up: refused before a picked file is even read.
    const read = vi.fn(async () => new Uint8Array())
    // The picker answers as the account switches (only once it is up: the binding was checked before).
    Object.defineProperty(world, 'picked', { configurable: true, get: () => { world.account = { token: 't', ownerId: OTHER }; return [{ ...picked('a.md'), read }] } })
    expect(await codeOf(bindings.manage(ASSISTANT_APP_ID, 'bindingsUpload', { name: 'main' }))).toBe('denied')
    expect(read).not.toHaveBeenCalled()
    Object.defineProperty(world, 'picked', { configurable: true, writable: true, value: null })
    world.account = { token: 't', ownerId: OWNER }
    // Files writable at API 49 (no voice-note managing there): upload is an App's of API 50 only.
    world.app = install({ manifest: assistantManifest({ permissions: { ...base.permissions,
      bindings: [{ ...binding, domains: { ...binding.domains, 'resources:write': ['memory', 'files'] } }] } }) })
    expect(await codeOf(bindings.manage(ASSISTANT_APP_ID, 'bindingsUpload', { name: 'main' }))).toBe('denied')
    world.app = install()
    expect(await codeOf(bindings.manage(ASSISTANT_APP_ID, 'bindingsUpload', { name: 'main' }))).toBe('denied')
    world.app = withManage()
    world.assistant = null
    expect(await bindings.manage(ASSISTANT_APP_ID, 'bindingsUpload', { name: 'main' })).toEqual({ name: 'main', state: 'unbound' })
    expect(commits).toEqual([])
  })

  it('removeVoiceNote: the layer asks first, as the built-in note page did; yes removes the note and all of it', async () => {
    world.app = withManage()
    withVoiceNote()
    const bindings = createPhoneBindings(ports())
    actions.confirmRemoval.mockImplementationOnce(async () => false)
    expect(await bindings.manage(ASSISTANT_APP_ID, 'bindingsRemoveVoiceNote', { name: 'main', key: 'n1' })).toEqual({ name: 'main', key: 'n1', state: 'cancelled' })
    expect(commits).toEqual([])
    const answer = await bindings.manage(ASSISTANT_APP_ID, 'bindingsRemoveVoiceNote', { name: 'main', key: 'n1' })
    expect(actions.confirmRemoval).toHaveBeenLastCalledWith({ kind: 'voice-note', title: null })
    expect(answer).toMatchObject({ name: 'main', key: 'n1', state: 'committed' })
    expect(commits.map((change) => [(change as { key: string }).key, (change as { operation: string }).operation])).toEqual([['n1/note.json', 'remove'], ['n1', 'remove']])
    expect(await bindings.manage(ASSISTANT_APP_ID, 'bindingsRemoveVoiceNote', { name: 'main', key: 'gone' })).toEqual({ name: 'main', key: 'gone', state: 'missing' })
  })

  it('removeVoiceNote: refused without voice-note managing, for a path, an account switched at the question; nothing removed', async () => {
    world.app = withManage()
    withVoiceNote()
    const bindings = createPhoneBindings(ports())
    expect(await codeOf(bindings.manage(ASSISTANT_APP_ID, 'bindingsRemoveVoiceNote', { name: 'main', key: 'n1/note.json' }))).toBe('invalid')
    actions.confirmRemoval.mockImplementationOnce(async () => { world.account = { token: 't', ownerId: OTHER }; return true })
    expect(await codeOf(bindings.manage(ASSISTANT_APP_ID, 'bindingsRemoveVoiceNote', { name: 'main', key: 'n1' }))).toBe('denied')
    world.account = { token: 't', ownerId: OWNER }
    world.app = install({ manifest: assistantManifest() })
    expect(await codeOf(bindings.manage(ASSISTANT_APP_ID, 'bindingsRemoveVoiceNote', { name: 'main', key: 'n1' }))).toBe('denied')
    expect(commits).toEqual([])
  })
})

describe('the layout signal and the unsupported-here states', () => {
  it('tells the page what the person asked through the layer (the recording bar\'s note, 自定义) once, with its surface, only while bound', async () => {
    const heard: unknown[] = []
    const stop = createPhoneBindings(ports()).attach(PAGE, (event) => heard.push(event))
    world.shown = { ...world.shown!, section: 'memory' }
    for (const listener of intentListeners) listener({ kind: 'voice-note' })
    await vi.waitFor(() => expect(heard).toContainEqual({ type: 'bindingSurface', surface: { name: 'main', state: 'bound', layout: 'phone', section: 'memory', hostPage: false, intent: { kind: 'voice-note' } } }))
    // Another account's layer, or the page not shown: nothing told.
    heard.length = 0
    world.shown = { ...world.shown!, ownerId: OTHER }
    for (const listener of intentListeners) listener({ kind: 'profile' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(heard.filter((event) => JSON.stringify(event).includes('intent'))).toEqual([])
    stop()
    expect(intentListeners.size).toBe(0)
  })
  it('tells the page the phone layout and the section it fills, only while the layer shows it', async () => {
    const bindings = createPhoneBindings(ports())
    expect(await bindings.surface(PAGE, { name: 'main' })).toEqual({ name: 'main', state: 'bound', layout: 'phone', section: 'today', hostPage: false })
    world.shown = { ...world.shown!, section: 'tasks' }
    expect(await bindings.surface(PAGE, { name: 'main' })).toEqual({ name: 'main', state: 'bound', layout: 'phone', section: 'tasks', hostPage: false })
    // One of the phone's own screens over the page (46's hostPage, top-level on a phone: there is no panel).
    world.shown = { ...world.shown!, hostPage: true }
    expect(await bindings.surface(PAGE, { name: 'main' })).toEqual({ name: 'main', state: 'bound', layout: 'phone', section: 'tasks', hostPage: true })
    world.shown = { ...world.shown!, hostPage: false }
    expect(await bindings.surface({ ...PAGE, tabId: 'elsewhere' }, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' })
    world.shown = { ...world.shown!, ownerId: OTHER }
    expect(await bindings.surface(PAGE, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' })
    world.shown = null
    expect(await bindings.surface(PAGE, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' })
    expect(await codeOf(bindings.surface(PAGE, { name: 'other' }))).toBe('denied')
  })
  it('is unbound when the binding no longer holds, whatever the layer says', async () => {
    world.conversation = { kind: 'group', members: [OWNER, AGENT] }
    expect(await createPhoneBindings(ports()).surface(PAGE, { name: 'main' })).toEqual({ name: 'main', state: 'unbound' })
  })
  it('moves the layer to one of the page\'s sections; collapsing a panel is unsupported here', async () => {
    const bindings = createPhoneBindings(ports())
    world.shown = { ...world.shown!, hostPage: true }
    // Moving to another section leaves the phone's own screen behind; staying keeps it.
    expect(await bindings.setPanel(PAGE, { name: 'main', section: 'today' })).toEqual({ name: 'main', state: 'bound', layout: 'phone', section: 'today', hostPage: true })
    expect(actions.move).not.toHaveBeenCalled()
    expect(await bindings.setPanel(PAGE, { name: 'main', section: 'memory' })).toEqual({ name: 'main', state: 'bound', layout: 'phone', section: 'memory', hostPage: false })
    expect(actions.move).toHaveBeenCalledWith('memory')
    expect(await bindings.setPanel(PAGE, { name: 'main', collapsed: true })).toEqual({ name: 'main', state: 'unsupported' })
    expect(await codeOf(bindings.setPanel(PAGE, { name: 'main', section: 'chat' }))).toBe('invalid')
    expect(actions.move).toHaveBeenCalledTimes(1)
  })
  // The screens `gugu.assistant.open` takes today; the panel's own pages (#1925) are mapped ahead and checked below.
  it.each(Object.entries(PHONE_ASSISTANT_SCREENS).filter(([screen]) => (ASSISTANT_SCREENS as readonly string[]).includes(screen)))('opens %s as the phone\'s own screen, or says it is unsupported here', async (screen, target) => {
    const answer = await createPhoneBindings(ports()).assistantOpen(ASSISTANT_APP_ID, { name: 'main', screen })
    if (target) {
      expect(answer).toBeUndefined()
      expect(actions.open).toHaveBeenCalledWith(target)
    } else {
      expect(answer).toEqual({ name: 'main', state: 'unsupported' })
      expect(actions.open).not.toHaveBeenCalled()
    }
  })
  it('maps every screen as the phone has it', () => {
    expect(PHONE_ASSISTANT_SCREENS).toEqual({
      setup: { section: 'profile', page: 'settings' }, move: null, close: { confirm: 'close' },
      // 换形象 is the look workshop itself, never 自定义 (the App draws its own customize page).
      look: { section: 'profile', page: 'look' },
      model: { section: 'profile', page: 'settings:aimodel' }, devices: { section: 'profile', page: 'devices' }, 'connected-apps': { connectors: true },
      health: { section: 'memory', page: 'health' },
      settings: { section: 'profile', page: 'settings' }, projects: { section: 'profile', page: 'library:workspace' },
      capabilities: { section: 'profile', page: 'library:capabilities' },
    })
    // Every screen the contract takes has a phone answer: a page of its own, or the closed unsupported state — never a dead tap.
    for (const screen of ASSISTANT_SCREENS) expect(PHONE_ASSISTANT_SCREENS).toHaveProperty([screen])
  })
  it('refuses to open a screen for an App not bound here, and answers advanceSetup unsupported', async () => {
    world.app = install({ origin: 'attachment' })
    expect(await codeOf(createPhoneBindings(ports()).assistantOpen(ASSISTANT_APP_ID, { name: 'main', screen: 'look' }))).toBe('not-found')
    expect(actions.open).not.toHaveBeenCalled()
    world.app = install()
    expect(await createPhoneBindings(ports()).assistantAdvanceSetup(ASSISTANT_APP_ID, { name: 'main', next: 'done' })).toEqual({ name: 'main', state: 'unsupported' })
    // The setup's connect step too: services are connected from 资料 on a phone.
    expect(await createPhoneBindings(ports()).assistantConnect(ASSISTANT_APP_ID, { name: 'main', id: 'gmail' })).toEqual({ name: 'main', state: 'unsupported' })
    expect(await codeOf(createPhoneBindings(ports()).assistantConnect(ASSISTANT_APP_ID, { name: 'other', id: 'gmail' }))).toBe('denied')
    // Unsupported only to an App that may ask: another binding's name, or no assistant:open grant, is refused.
    expect(await codeOf(createPhoneBindings(ports()).assistantAdvanceSetup(ASSISTANT_APP_ID, { name: 'other', next: 'done' }))).toBe('denied')
    const base = assistantManifest()
    world.app = install({ manifest: { ...base, permissions: { ...base.permissions, capabilities: base.permissions!.capabilities!.filter((c) => c !== 'assistant:open') } } as ExtensionManifest })
    expect(await codeOf(createPhoneBindings(ports()).assistantAdvanceSetup(ASSISTANT_APP_ID, { name: 'main', next: 'done' }))).toBe('denied')
  })
  it('renames the assistant by the built-in field\'s rule, the way 自定义 saves it', async () => {
    const bindings = createPhoneBindings(ports())
    expect(await bindings.assistantRename(ASSISTANT_APP_ID, { name: 'main', text: '  Kiwi ' })).toBe('renamed')
    expect(actions.rename).toHaveBeenCalledExactlyOnceWith(AGENT, 'Kiwi')
    expect(await bindings.assistantRename(ASSISTANT_APP_ID, { name: 'main', text: 'Pip' })).toBe('unchanged')
    expect(await bindings.assistantRename(ASSISTANT_APP_ID, { name: 'main', text: '   ' })).toBe('empty')
    expect(await bindings.assistantRename(ASSISTANT_APP_ID, { name: 'main', text: 'x'.repeat(31) })).toBe('too-long')
    actions.rename.mockRejectedValueOnce(new Error('offline'))
    expect(await bindings.assistantRename(ASSISTANT_APP_ID, { name: 'main', text: 'Kiwi' })).toBe('failed')
    expect(actions.rename).toHaveBeenCalledTimes(2)
    // Refused before anything is saved: another binding, an App not bound here, or a name the layer has not shown.
    expect(await codeOf(bindings.assistantRename(ASSISTANT_APP_ID, { name: 'other', text: 'Kiwi' }))).toBe('denied')
    world.status = { ownerId: OTHER, status: FOUND }
    expect(await codeOf(bindings.assistantRename(ASSISTANT_APP_ID, { name: 'main', text: 'Kiwi' }))).toBe('failed')
    world.status = { ownerId: OWNER, status: FOUND }
    world.app = install({ origin: 'attachment' })
    expect(await codeOf(bindings.assistantRename(ASSISTANT_APP_ID, { name: 'main', text: 'Kiwi' }))).toBe('not-found')
    expect(actions.rename).toHaveBeenCalledTimes(2)
  })
  it('answers the figure unsupported on a phone (its header draws the face), only to an App that may ask', async () => {
    const bindings = createPhoneBindings(ports())
    expect(await bindings.assistantFigure(ASSISTANT_APP_ID, { name: 'main', figure: { x: 0, y: 0, size: 64 } })).toEqual({ name: 'main', state: 'unsupported' })
    expect(await bindings.assistantFigure(ASSISTANT_APP_ID, { name: 'main', figure: null })).toEqual({ name: 'main', state: 'unsupported' })
    expect(await codeOf(bindings.assistantFigure(ASSISTANT_APP_ID, { name: 'other', figure: null }))).toBe('denied')
    expect(await codeOf(bindings.assistantFigure(ASSISTANT_APP_ID, { name: 'main', figure: { x: 0, y: 0, size: 2 } }))).toBe('invalid')
  })
  it.each([
    ['voiceNoteStatus', { name: 'main' }], ['voiceNoteStart', { name: 'main' }], ['voiceNotePause', { name: 'main' }],
    ['voiceNoteResume', { name: 'main' }], ['voiceNoteStop', { name: 'main' }], ['voiceNoteOpenMicSettings', { name: 'main' }],
    ['voiceNoteRetry', { name: 'main', job: WORK }], ['voiceNoteWatch', { watchId: 'w1', name: 'main', on: true }],
  ] as const)('answers %s unsupported on a phone (its own 聊天 records), only to an App granted the recorder', async (method, args) => {
    // The manifest holds 12 capabilities at most and the binding now has 13: the recorder's in place of rename here.
    const base = assistantManifest()
    const binding = base.permissions!.bindings![0]!
    world.app = install({ manifest: assistantManifest({ permissions: { ...base.permissions,
      capabilities: [...base.permissions!.capabilities!.filter((c) => c !== 'assistant:rename'), 'chat:voice-notes:record'],
      bindings: [{ ...binding, actions: [...binding.actions.filter((a) => a !== 'assistant-rename'), 'voice-notes:record'] }] } }) })
    const bindings = createPhoneBindings(ports())
    expect(await answerPhoneBinding(bindings, method, PAGE, { ...args }, () => undefined)).toEqual({ name: 'main', state: 'unsupported' })
    expect(await codeOf(answerPhoneBinding(bindings, method, PAGE, { ...args, name: 'other' }, () => undefined)!)).toBe('denied')
    expect(await codeOf(answerPhoneBinding(bindings, method, PAGE, { ...args, extra: 1 }, () => undefined)!)).toBe('invalid')
    world.app = install()
    expect(await codeOf(answerPhoneBinding(bindings, method, PAGE, { ...args }, () => undefined)!)).toBe('denied')
  })
  it('says a phone screen is drawn over the page (hostPage) only for this App and account', async () => {
    const bindings = createPhoneBindings(ports())
    expect(await bindings.assistantStatus(ASSISTANT_APP_ID, { name: 'main' })).toMatchObject({ state: 'ready', hostPage: false })
    world.shown = { ...world.shown!, hostPage: true }
    expect(await bindings.assistantStatus(ASSISTANT_APP_ID, { name: 'main' })).toMatchObject({ state: 'ready', hostPage: true })
    world.shown = { ...world.shown!, extensionId: 'another-app' }
    expect(await bindings.assistantStatus(ASSISTANT_APP_ID, { name: 'main' })).toMatchObject({ state: 'ready', hostPage: false })
  })
  it('answers the assistant\'s status from the layer, for this account only', async () => {
    const bindings = createPhoneBindings(ports())
    expect(await bindings.assistantStatus(ASSISTANT_APP_ID, { name: 'main' })).toEqual({ name: 'main', state: 'ready', status: FOUND, hostPage: false })
    world.status = { ownerId: OTHER, status: FOUND }
    expect(await bindings.assistantStatus(ASSISTANT_APP_ID, { name: 'main' })).toEqual({ name: 'main', state: 'unavailable' })
    world.status = { ownerId: OWNER, status: { ...FOUND, assistant: 'none', name: 'x' } }
    world.assistant = null
    expect(await bindings.assistantStatus(ASSISTANT_APP_ID, { name: 'main' })).toMatchObject({ state: 'ready', status: { assistant: 'none', name: null, home: null } })
  })
})

describe('resources, schedules and work on a phone', () => {
  it('lists a granted domain with the allow-listed fields and refuses one not declared', async () => {
    const bindings = createPhoneBindings(ports())
    const listed = await bindings.resources(ASSISTANT_APP_ID, { name: 'main', domain: 'memory' })
    expect(listed).toMatchObject({ state: 'ready', revision: '9', resources: [{ key: 'notes/a.md', data: { title: 'A', relativePath: 'notes/a.md' } }] })
    expect(JSON.stringify(listed)).not.toContain('secret')
    expect(await codeOf(bindings.resources(ASSISTANT_APP_ID, { name: 'main', domain: 'skills' }))).toBe('denied')
    expect(await codeOf(bindings.resources(ASSISTANT_APP_ID, { name: 'main', domain: 'integrations' }))).toBe('denied')
    expect(await codeOf(bindings.save(ASSISTANT_APP_ID, { name: 'main', domain: 'files', key: 'a', operationId: crypto.randomUUID(), expectedRevision: '0', content: 'x' }))).toBe('denied')
  })
  it('saves through the store as the person: committed with a receipt', async () => {
    const operationId = crypto.randomUUID()
    expect(await createPhoneBindings(ports()).save(ASSISTANT_APP_ID, { name: 'main', domain: 'memory', key: 'notes/b.md', operationId, expectedRevision: '0', content: '# B' }))
      .toMatchObject({ state: 'committed', receipt: { operationId, status: 'pending' } })
    expect(commits).toHaveLength(1)
  })
  it('reads the assistant\'s schedules through its panel and pauses one once per operation id', async () => {
    world.snapshot = { version: 1, revision: '9', application: [], items: [
      panelItem('schedules', '__collection__', { state: 'ready' }),
      panelItem('schedules', SCHEDULE, { title: 'Daily', prompt: 'p', cron: '0 9 * * *', enabled: true }),
    ] }
    const bindings = createPhoneBindings(ports())
    const listed = await bindings.schedules(ASSISTANT_APP_ID, { name: 'main' })
    expect(listed).toMatchObject({ state: 'ready', schedules: [{ id: `schedule:${SCHEDULE}`, revision: '3', title: 'Daily', state: 'active' }] })
    const change = { name: 'main', operationId: 'op-pause-0001', op: 'pause', scheduleId: `schedule:${SCHEDULE}`, revision: '3' }
    const first = await bindings.controlSchedule(ASSISTANT_APP_ID, change)
    expect(first).toMatchObject({ status: 'pending', scheduleId: `schedule:${SCHEDULE}` })
    await bindings.controlSchedule(ASSISTANT_APP_ID, change)
    expect(commits.map((commit) => (commit as { operationId: string }).operationId)).toEqual([expect.any(String), (commits[0] as { operationId: string }).operationId])
    expect(await codeOf(bindings.controlSchedule(ASSISTANT_APP_ID, { ...change, revision: '2' }))).toBe('invalid')
    expect(await codeOf(bindings.controlSchedule(ASSISTANT_APP_ID, { name: 'main', operationId: 'op-register-01', op: 'register', prompt: 'x', at: '2027-01-01T00:00:00Z' }))).toBe('invalid')
  })
  it('gives the work list by opaque handles and opens a task\'s conversation by one', async () => {
    const bindings = createPhoneBindings(ports())
    expect(await bindings.work(ASSISTANT_APP_ID, { name: 'main' })).toEqual({ name: 'main', state: 'unavailable', open: null })
    world.work = { ownerId: OWNER, assistantId: AGENT, state: 'ready', rows: [{ workId: WORK, sessionId: 'session-secret', title: 'Book', naming: false, status: null, unseen: true, updatedAt: '2026-11-11T10:00:00.000Z' }] }
    const listed = await bindings.work(ASSISTANT_APP_ID, { name: 'main' })
    expect(listed).toMatchObject({ state: 'ready', stale: false, open: null, items: [{ title: 'Book', unseen: true }] })
    expect(JSON.stringify(listed)).not.toMatch(/session-secret|2a000000/)
    const handle = (listed as { items: { handle: string }[] }).items[0]!.handle
    expect(handle).toMatch(/^w[A-Za-z0-9_-]{22}$/)
    await bindings.openWork(ASSISTANT_APP_ID, { name: 'main', handle })
    expect(actions.openWork).toHaveBeenCalledWith({ workId: WORK, sessionId: 'session-secret' })
    expect(await codeOf(bindings.openWork(ASSISTANT_APP_ID, { name: 'main', handle: `w${'x'.repeat(22)}` }))).toBe('not-found')
    world.work = { ...world.work, ownerId: OTHER }
    expect(await bindings.work(ASSISTANT_APP_ID, { name: 'main' })).toMatchObject({ state: 'unavailable' })
  })
})

describe('the phone host\'s door', () => {
  it('answers each binding verb and nothing else', async () => {
    const bindings = createPhoneBindings(ports())
    expect(answerPhoneBinding(bindings, 'filesList', PAGE, {}, () => undefined)).toBeNull()
    expect(await answerPhoneBinding(bindings, 'bindingsSurface', PAGE, { name: 'main' }, () => undefined)).toMatchObject({ layout: 'phone' })
  })
})
