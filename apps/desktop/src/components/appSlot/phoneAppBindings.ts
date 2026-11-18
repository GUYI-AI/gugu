import { z } from 'zod'
import type { AssistantPanelClient, AssistantPanelCommit, AssistantPanelDomain, AssistantPanelItem, AssistantPanelReceipt, AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import { ASSISTANT_PANEL_PATHS, createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { resourceRejection } from '@gugu/core/shared/assistantResourceRules'
import { VOICE_NOTE_META_FILE, VOICE_NOTES_DIR, parseVoiceNoteMeta } from '@gugu/core/shared/voiceNotes'
import { splitInstructions } from '@gugu/core/shared/assistantInstructions'
import {
  READABLE_RESOURCE_DOMAINS, WRITABLE_RESOURCE_DOMAINS, appResourceOf, resourceChangeSchema, resourceDomainOf, resourceKeyOf,
  type AppResourceEvent, type AppResourceList, type AppResourceRead, type AppResourceWrite, type ReadableResourceDomain, type ResourceBindingAction,
} from '../../session/shared/extensions/agent-resources'
import { DEFAULT_TEXT_MAX_BYTES, type AppFileEntry } from '../../session/shared/extensions/app-runtime-protocol'
import type { PathText } from '../../session/shared/extensions/app-files-core'
import { dispatchCallOf } from '../../session/shared/extensions/app-dispatch-core'
import { ASSISTANT_SCREENS, assistantFigureSchema, renameCheck, withoutAssistant, type AppAssistantRead, type AppAssistantStatus, type AssistantRenameResult } from '../../session/shared/extensions/assistant-binding'
import { assistantLayerEntry, type AssistantAppInstall } from '../../session/shared/extensions/assistant-entry'
import { domainState, reasonOf, refusedOrUnavailable, savedData, unavailable, writeOutcome } from '../../session/shared/extensions/bound-resources-core'
import {
  RESOURCES_MANAGEMENT_API_VERSION, folderArgsSchema, renameArgsSchema, uploadArgsSchema, VOICE_NOTES_MANAGE_ACTION, voiceNoteArgsSchema,
  type AppRemoveAllAnswer, type AppUploadAnswer, type Unavailable,
} from '../../session/shared/extensions/resources-management'
import type { ExtensionHostEvent } from '../../session/shared/extensions/bridge-protocol'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { VOICE_NOTE_RECORD_ACTION, voiceNoteNameSchema, voiceNoteRetrySchema, voiceNoteStartSchema, voiceNoteWatchSchema } from '../../session/shared/extensions/voice-note-session'
import { PHONE_ASSISTANT_SCREENS, PHONE_SURFACE_SECTIONS, unsupportedHere, type AppBindingUnsupported, type PhoneSurfaceSection } from '../../session/shared/extensions/phone-binding'
import {
  BINDING_ACTION_CAPABILITY, boundEntryOf, boundPathOf,
  type AppBindingSurface, type AppBoundList, type AppBoundRead, type AppSurfaceIntent, type AppUnreadBinding, type ConversationBindingAction,
} from '../../session/shared/extensions/unread-binding'
import { scheduleControlSchema, type AppBoundSchedules, type AppScheduleReceipt } from '../../session/shared/extensions/bound-schedules'
import { commitPanelRequest, listPanelSchedules, panelSchedulesPrint, planPanelChange, type PanelHome, type PanelOutcome, type PanelRequest } from '../../session/shared/extensions/bound-schedules-panel'
import type { AppBindingWork, AppWorkItem, PushedWorkLedger } from '../../session/shared/extensions/work-binding'
import type { PhoneLayerActions, PhoneLayerShown, PhoneLayerStatus } from './phoneAssistantLayer'

/**
 * The conversation binding on a phone (API 49, phone-binding.ts): the desktop main process's verbs (electron
 * `app-unread-bindings.ts`, `app-bound-resources.ts`, `app-assistant-binding.ts`), answered by the phone's own App host,
 * this page, under the same authority, failing closed:
 * - the account: the one signed in on this page now (`account`), the same after every wait;
 * - the App: installed on this phone, switched on, the binding and the action declared and its capability granted (the
 *   phone's stored manifest is its grant), the same installation after every wait (`stampOf`);
 * - the conversation: a phone has no picker. The host binds only the App the assistant's place opens
 *   (`assistantLayerEntry`, the product's assistant App, trusted), and only to the account's private chat with its own
 *   assistant — its provision marker names the chat, the chat is a `dm` of the account and that assistant alone. Anything
 *   else is `unbound`: never another chat, never the App's word.
 * The App names the binding, a path, a domain and key, or a screen; never a chat, account, agent or device.
 */

export type PhoneInstalledApp = AssistantAppInstall & { manifest: ExtensionManifest; manifestDigest: string | null }

export interface PhoneBindingPorts {
  /** The account signed in on this page now; null: none. */
  account(): { token: string; ownerId: string } | null
  /** The App as installed on this phone now; null: not installed. */
  installed(extensionId: string): PhoneInstalledApp | null
  /** The account's own assistant and its private chat, by the provision marker; null: it has none ready. `failed`: unknown. */
  personalAssistant(token: string, ownerId: string): Promise<{ agentId: string; chatId: string; deviceId: string } | null>
  /** What the chat is and who is in it now. `failed`: unknown. */
  conversation(token: string, chatId: string): Promise<{ kind: string | null; members: string[] }>
  files: {
    list(chatId: string, folder: string | undefined): Promise<(AppFileEntry & { chat?: string })[]>
    read(chatId: string, path: string, maxBytes: number): Promise<PathText>
    resourceChat(chatId: string): Promise<string>
  }
  /** Words into that chat's composer (the layer's conversation comes up); nothing is sent. */
  draft(chatId: string, text: string): Promise<void>
  /** The assistant renamed the way 自定义 renames it (its identity in the cloud and this phone's contacts). */
  renameAssistant(agentId: string, name: string): Promise<void>
  /** API 50 `upload`: the phone's own picker, inside the person's gesture; null: cancelled. */
  pickFiles(): Promise<PhonePickedFile[] | null>
  /** API 50 `removeVoiceNote`: the layer's own question first (删除“…”？); true = yes. */
  confirmRemoval(question: { kind: 'voice-note'; title: string | null }): Promise<boolean>
  panel: {
    /** The assistant panel's client as the person (its schedules are read and changed through it, #1928). */
    client: AssistantPanelClient
    snapshot(ownerId: string, agentId: string): Promise<AssistantPanelSnapshot>
    resource(ownerId: string, agentId: string, domain: AssistantPanelDomain, key: string): Promise<AssistantPanelItem | null>
    commit(ownerId: string, agentId: string, change: AssistantPanelCommit): Promise<AssistantPanelReceipt>
    readBody(item: AssistantPanelItem, access: { token: string; ownerId: string; chatId: string; maxBytes: number }): Promise<Uint8Array>
    uploadBody(access: { token: string; ownerId: string; chatId: string; label: string; bytes: Uint8Array }): Promise<{ itemId: string; sha256: string }>
    discard(token: string, ownerId: string, itemId: string): Promise<void>
    /** Something of the account's resources changed; returns the stop. */
    subscribe(ownerId: string, onChange: () => void): () => void
  }
  layer: {
    shown(): PhoneLayerShown | null
    onShown(listener: () => void): () => void
    actions(): PhoneLayerActions | null
    status(): PhoneLayerStatus | null
    onStatus(listener: () => void): () => void
    work(): PushedWorkLedger | null
    openWork(): { ownerId: string; workId: string; sessionId: string } | null
    onWork(listener: () => void): () => void
    /** What the person asked of the App's page through the layer (`AppSurfaceIntent`), told once. */
    onIntent(listener: (intent: AppSurfaceIntent) => void): () => void
  }
  randomUUID(): string
  sha256(bytes: Uint8Array): Promise<string>
}

/** A file the person picked on the phone: its name, size and type, its bytes read when written. */
export type PhonePickedFile = { name: string; size: number; contentType: string; read(): Promise<Uint8Array> }

/** The page asking: which App, which of its tabs (`tabId`), and whether the person works it (a phone page always is). */
export type PhoneBindingPage = { extensionId: string; tabId: string }

const coded = (code: 'denied' | 'invalid' | 'failed' | 'not-found', message: string) => Object.assign(new Error(message), { code })
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code
function argsOf<T extends z.ZodType>(schema: T, input: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw coded('invalid', `${what} (${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')})`)
  return parsed.data
}
const BINDING_ARGS = 'gugu.bindings takes the binding\'s name and a path in its conversation, never a chat, account or file id'
const RESOURCE_ARGS = 'gugu.bindings takes the binding\'s name, a resource domain and key, never an owner, agent, chat or path'

/** Grants of the App on this phone, as the installed manifest holds them; what a binding call needs is checked here. */
function declared(app: PhoneInstalledApp, name: string, action: ConversationBindingAction, domain?: string): void {
  const binding = app.manifest.permissions?.bindings?.[0]
  const granted = app.manifest.permissions?.capabilities ?? []
  if (!app.enabled || binding?.name !== name || !granted.includes(BINDING_ACTION_CAPABILITY.unread)) {
    throw coded('denied', 'This App has no unread grant for this binding')
  }
  if (!binding.actions.includes(action) || !granted.includes(BINDING_ACTION_CAPABILITY[action])) {
    throw coded('denied', `This App has no "${action}" grant for this binding`)
  }
  if (domain !== undefined && (action === 'resources' || action === 'resources:write') && !(binding.domains?.[action as ResourceBindingAction] ?? []).includes(domain)) {
    throw coded('denied', `This App has no "${action}" grant for the ${domain} domain`)
  }
}

/** One installation as it is now: an update, a switch, a reinstall from elsewhere is another. */
function stampOf(app: PhoneInstalledApp | null): string {
  return app ? JSON.stringify([app.manifest.id, app.manifest.version, app.manifestDigest, app.origin ?? null, app.marketSource?.repo ?? null, app.marketSource?.path ?? null, app.enabled, app.activeVariant]) : 'none'
}

type Bound = { ownerId: string; token: string; chatId: string; agentId: string; deviceId: string; handle: string; recheck(): void }

export function createPhoneBindings(ports: PhoneBindingPorts) {
  const handles = new Map<string, string>()
  const handleOf = (key: string) => {
    let handle = handles.get(key)
    if (!handle) handles.set(key, (handle = ports.randomUUID()))
    return handle
  }

  function signedIn() {
    const account = ports.account()
    if (!account) throw coded('denied', 'Not signed in')
    return account
  }
  function installed(extensionId: string): PhoneInstalledApp {
    const app = ports.installed(extensionId)
    if (!app) throw coded('denied', 'This App is not installed')
    return app
  }
  const actionsOf = (app: PhoneInstalledApp): ConversationBindingAction[] => {
    const granted = app.manifest.permissions?.capabilities ?? []
    return (app.manifest.permissions?.bindings?.[0]?.actions ?? []).filter((action) => granted.includes(BINDING_ACTION_CAPABILITY[action]))
  }

  /**
   * The authority one call works under (`actions` each declared and granted, a resource `domain` listed): the account's private
   * chat with its own assistant, for the App the assistant's place opens. `recheck`: the same account, the same installation —
   * called after every wait. Null: there is nothing bound on this phone (another App, or no assistant ready yet).
   */
  async function bound(extensionId: string, name: string, actions: readonly ConversationBindingAction[], domain?: string): Promise<Bound | null> {
    const { token, ownerId } = signedIn()
    const app = installed(extensionId)
    for (const action of actions) declared(app, name, action, domain)
    const stamp = stampOf(app)
    const recheck = () => {
      if (ports.account()?.ownerId !== ownerId) throw coded('denied', 'Account changed')
      if (stampOf(ports.installed(extensionId)) !== stamp) throw coded('denied', 'Conversation binding changed')
    }
    const entry = assistantLayerEntry(app, 'phone')
    if (entry.entry !== 'app' || entry.extensionId !== extensionId || entry.binding !== name) return null
    const assistant = await ports.personalAssistant(token, ownerId)
    recheck()
    if (!assistant) return null
    const conversation = await ports.conversation(token, assistant.chatId)
    recheck()
    const members = new Set(conversation.members)
    if (conversation.kind !== 'dm' || members.size !== 2 || !members.has(ownerId) || !members.has(assistant.agentId)) {
      throw coded('denied', 'The bound conversation is not your private chat with your own assistant')
    }
    return { ownerId, token, chatId: assistant.chatId, agentId: assistant.agentId, deviceId: assistant.deviceId, handle: handleOf(JSON.stringify([ownerId, stamp, assistant.chatId])), recheck }
  }
  /** As `bound`, a check that could not be made said apart (`unavailable`) from a refusal (thrown). */
  const boundOrUnavailable = (extensionId: string, name: string, actions: readonly ConversationBindingAction[], domain?: string) =>
    bound(extensionId, name, actions, domain).catch((error: unknown) => {
      if (codeOf(error) === 'failed') return 'unavailable' as const
      throw error
    })

  // ── 37 / 40: the binding, its folder, a draft ─────────────────────────────────────────────────────────────────────
  async function get(extensionId: string, input: unknown): Promise<AppUnreadBinding> {
    const { name } = argsOf(z.strictObject({ name: z.string() }), input, BINDING_ARGS)
    const app = installed(extensionId)
    declaredUnread(app, name)
    const at = await bound(extensionId, name, [])
    at?.recheck()
    const actions = actionsOf(installed(extensionId))
    return at ? { name, state: 'bound', handle: at.handle, actions } : { name, state: 'unbound', actions }
  }
  function declaredUnread(app: PhoneInstalledApp, name: string) {
    const binding = app.manifest.permissions?.bindings?.[0]
    if (!app.enabled || binding?.name !== name || !(app.manifest.permissions?.capabilities ?? []).includes('chat:unread')) {
      throw coded('denied', 'This App has no unread grant for this binding')
    }
  }

  /** What `use` read of the bound chat's own folder, or why there is nothing (`unbound` / `missing` / `unavailable`). */
  async function inFolder<T>(extensionId: string, name: string, use: (chatId: string) => Promise<T>): Promise<{ value: T } | { name: string; state: 'unbound' | 'missing' | 'unavailable' }> {
    const at = await boundOrUnavailable(extensionId, name, ['files'])
    if (at === 'unavailable') return { name, state: 'unavailable' }
    if (!at) return { name, state: 'unbound' }
    // A topic's files are its source chat's: only a conversation keeping its own folder is read.
    const resource = await ports.files.resourceChat(at.chatId).catch((error: unknown) => {
      if (codeOf(error) === 'failed') throw error
      throw coded('denied', 'The bound conversation cannot be read as this account')
    })
    at.recheck()
    if (resource !== at.chatId) throw coded('denied', 'The bound conversation keeps no folder of its own')
    try {
      const value = await use(at.chatId)
      at.recheck()
      return { value }
    } catch (error) {
      const code = codeOf(error)
      if (code !== 'not-found' && code !== 'failed') throw error
      at.recheck()
      return { name, state: code === 'not-found' ? 'missing' : 'unavailable' }
    }
  }
  async function list(extensionId: string, input: unknown): Promise<AppBoundList> {
    const { name, folder } = argsOf(z.strictObject({ name: z.string(), folder: z.unknown().optional() }), input, BINDING_ARGS)
    const at = folder === undefined ? undefined : boundPathOf(folder, 'folder')
    const listed = await inFolder(extensionId, name, async (chatId) =>
      (await ports.files.list(chatId, at)).filter((entry) => entry.chat === undefined || entry.chat === chatId).map(boundEntryOf))
    return 'value' in listed ? { name, state: 'ready', entries: listed.value } : listed
  }
  async function read(extensionId: string, input: unknown): Promise<AppBoundRead> {
    const { name, path } = argsOf(z.strictObject({ name: z.string(), path: z.unknown() }), input, BINDING_ARGS)
    const at = boundPathOf(path, 'path')
    const got = await inFolder(extensionId, name, (chatId) => ports.files.read(chatId, at, DEFAULT_TEXT_MAX_BYTES))
    if (!('value' in got)) return got
    if (got.value.state !== 'ready') return { name, state: got.value.state }
    const { entry, ...text } = got.value
    return { name, ...text, entry: boundEntryOf(entry) }
  }
  /** `dispatch(text, { draft: true, to: { binding } })` (40, `chat:draft`): into the bound chat's composer; nothing is sent. */
  async function draft(extensionId: string, args: Record<string, unknown>): Promise<{ to: { binding: string } } | AppBindingUnsupported> {
    const call = dispatchCallOf(args)
    if (!call.draft || !call.to || !('binding' in call.to)) throw coded('invalid', 'A binding\'s conversation takes only a draft: { draft: true, to: { binding } }')
    const name = call.to.binding
    const at = await bound(extensionId, name, ['draft'])
    if (!at) throw coded('not-found', `No conversation is bound for "${name}" on this phone`)
    at.recheck()
    // 50's `attach`: files are not put into the phone's composer from an App — nothing is placed, never the text without them.
    if (call.attach) return unsupportedHere(name)
    await ports.draft(at.chatId, `${call.text}\n`)
    return { to: { binding: name } }
  }

  // ── 41 / 48: where the page is ──────────────────────────────────────────────────────────────────────────────────
  async function surface(page: PhoneBindingPage, input: unknown): Promise<AppBindingSurface> {
    const { name } = argsOf(z.strictObject({ name: z.string() }), input, BINDING_ARGS)
    return surfaceOf(page, name)
  }
  async function surfaceOf(page: PhoneBindingPage, name: string): Promise<AppBindingSurface> {
    if (installed(page.extensionId).manifest.contributes.conversationSurface?.binding !== name) {
      throw coded('denied', `"${name}" is not the binding this App's page is placed beside (contributes.conversationSurface)`)
    }
    const unbound = { name, state: 'unbound' } as const
    const here = () => {
      const shown = ports.layer.shown()
      return shown?.extensionId === page.extensionId && shown.tabId === page.tabId ? shown : null
    }
    if (!here()) return unbound
    const at = await bound(page.extensionId, name, ['surface']).catch(() => null)
    const shown = here()
    if (!at || !shown || shown.ownerId !== at.ownerId) return unbound
    try {
      at.recheck()
    } catch {
      return unbound
    }
    return { name, state: 'bound', layout: 'phone', section: shown.section, hostPage: shown.hostPage }
  }
  /**
   * `setPanel(name, { section })` moves the layer to one of the page's sections, while it shows this page; `{ collapsed }`
   * means nothing on a phone (`unsupported`). Unbound, nothing changes.
   */
  async function setPanel(page: PhoneBindingPage, input: unknown): Promise<AppBindingSurface | AppBindingUnsupported> {
    const args = argsOf(z.union([
      z.strictObject({ name: z.string(), collapsed: z.boolean() }),
      z.strictObject({ name: z.string(), section: z.enum(PHONE_SURFACE_SECTIONS) }),
    ]), input, 'gugu.bindings.setPanel takes the binding\'s name and { collapsed } (a computer) or { section } (a phone)')
    const now = await surfaceOf(page, args.name)
    if ('collapsed' in args) return unsupportedHere(args.name)
    if (now.state !== 'bound') return now
    const actions = ports.layer.actions()
    if (!actions) return { name: args.name, state: 'unbound' }
    const moved = now.layout === 'phone' && now.section !== args.section
    if (moved) actions.move(args.section as PhoneSurfaceSection)
    // Moving to another section leaves any of the phone's own screens behind (the layer opens that section's page).
    return { name: args.name, state: 'bound', layout: 'phone', section: args.section, hostPage: !moved && now.layout === 'phone' && now.hostPage }
  }

  // ── 42: the assistant's resources ───────────────────────────────────────────────────────────────────────────────
  function readableDomainOf(value: unknown): ReadableResourceDomain {
    const domain = resourceDomainOf(value)
    if (!(READABLE_RESOURCE_DOMAINS as readonly string[]).includes(domain)) throw coded('denied', `The ${domain} resources are never granted to an App`)
    return domain as ReadableResourceDomain
  }
  async function withResources<T>(extensionId: string, name: string, domain: string, use: (at: Bound) => Promise<T>): Promise<T | 'unbound' | Unavailable> {
    const at = await bound(extensionId, name, ['resources'], domain).catch((error: unknown) => {
      if (codeOf(error) === 'failed') return unavailable(reasonOf(error))
      throw error
    })
    if (at === null) return 'unbound'
    if ('state' in at) return at
    try {
      const value = await use(at)
      at.recheck()
      return value
    } catch (error) {
      const outcome = refusedOrUnavailable(error)
      at.recheck()
      return outcome
    }
  }
  async function resources(extensionId: string, input: unknown): Promise<AppResourceList> {
    const args = argsOf(z.strictObject({ name: z.string(), domain: z.unknown() }), input, RESOURCE_ARGS)
    const domain = readableDomainOf(args.domain)
    const named = { name: args.name, domain }
    const answer = await withResources(extensionId, args.name, domain, async (at): Promise<AppResourceList> => {
      const snapshot = await ports.panel.snapshot(at.ownerId, at.agentId)
      const readable = domainState(snapshot, domain)
      if (readable.state !== 'ready') return { ...named, ...readable }
      return { ...named, state: 'ready', revision: snapshot.revision, resources: readable.items.map((item) => appResourceOf(domain, item)) }
    })
    return answer === 'unbound' ? { ...named, state: answer } : 'name' in answer ? answer : { ...named, ...answer }
  }
  async function resource(extensionId: string, input: unknown): Promise<AppResourceRead> {
    const args = argsOf(z.strictObject({ name: z.string(), domain: z.unknown(), key: z.unknown() }), input, RESOURCE_ARGS)
    const domain = readableDomainOf(args.domain)
    const key = resourceKeyOf(domain, args.key)
    const named = { name: args.name, domain, key }
    const answer = await withResources(extensionId, args.name, domain, async (at): Promise<AppResourceRead> => {
      const [snapshot, item] = await Promise.all([
        domain === 'voice-notes' ? null : ports.panel.snapshot(at.ownerId, at.agentId),
        ports.panel.resource(at.ownerId, at.agentId, domain as AssistantPanelDomain, key),
      ])
      at.recheck()
      const readable = snapshot ? domainState(snapshot, domain) : null
      if (readable && readable.state !== 'ready') return { ...named, ...readable }
      if (!item) return { ...named, state: 'missing', revision: '0' }
      if (item.deleted_at) return { ...named, state: 'missing', revision: item.revision, deleted: true }
      if (item.stale_at) return { ...named, ...unavailable('stale') }
      const found = appResourceOf(domain, item)
      const ready = (bytes: Uint8Array) => {
        if (bytes.byteLength > DEFAULT_TEXT_MAX_BYTES) return { ...named, state: 'ready' as const, resource: found, content: '', truncated: true, totalSize: bytes.byteLength }
        try {
          return { ...named, state: 'ready' as const, resource: found, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), truncated: false, totalSize: bytes.byteLength }
        } catch {
          return { ...named, state: 'ready' as const, resource: found, content: '', binary: true as const, truncated: false, totalSize: bytes.byteLength }
        }
      }
      if (domain === 'personality') return ready(new TextEncoder().encode(typeof item.data.text === 'string' ? item.data.text : ''))
      if (!item.body_item_id) return item.data.kind === 'directory' ? ready(new Uint8Array()) : { ...named, state: 'unprepared' }
      try {
        const bytes = await ports.panel.readBody(item, { token: at.token, ownerId: at.ownerId, chatId: at.chatId, maxBytes: DEFAULT_TEXT_MAX_BYTES })
        at.recheck()
        return ready(bytes)
      } catch (error) {
        const code = codeOf(error)
        if (code === 'too-large') return { ...named, state: 'ready', resource: found, content: '', truncated: true, totalSize: Number((error as { size?: unknown }).size) || 0 }
        if (code === 'deleted') return { ...named, state: 'missing', revision: item.revision, deleted: true }
        if (code === 'body-unavailable') return { ...named, state: 'unprepared' }
        throw error
      }
    })
    return answer === 'unbound' ? { ...named, state: answer } : 'name' in answer ? answer : { ...named, ...answer }
  }

  type Writable = 'memory' | 'files' | 'personality' | 'skills'
  type Prepared = { data: Record<string, unknown>; body?: { itemId: string; sha256: string }; uploaded?: string } | 'conflict'
  async function change(extensionId: string, input: unknown, operation: 'save' | 'remove',
    prepare: (at: Bound, change: { domain: Writable; key: string; expectedRevision: string; content: string }) => Promise<Prepared>): Promise<AppResourceWrite> {
    const schema = operation === 'save'
      ? resourceChangeSchema.extend({ name: z.string(), content: z.string() })
      : resourceChangeSchema.omit({ content: true }).extend({ name: z.string() })
    const args = argsOf(schema, input, RESOURCE_ARGS) as z.infer<typeof resourceChangeSchema> & { name: string }
    const domain = readableDomainOf(args.domain) as Writable
    if (!(WRITABLE_RESOURCE_DOMAINS as readonly string[]).includes(domain)) throw coded('invalid', `The ${domain} resources are read only`)
    const key = resourceKeyOf(domain, args.key, true)
    const named = { name: args.name, domain, key }
    const content = args.content ?? ''
    if (new TextEncoder().encode(content).byteLength > DEFAULT_TEXT_MAX_BYTES) throw coded('invalid', 'content is at most 20 MiB')
    // A change needs reading the domain too, as on a computer.
    const at = await bound(extensionId, args.name, ['resources', 'resources:write'], domain).catch((error: unknown) => {
      if (codeOf(error) === 'failed') return unavailable(reasonOf(error))
      throw error
    })
    if (!at) return { ...named, state: 'unbound' }
    if ('state' in at) return { ...named, ...at }
    let uploaded: string | undefined
    try {
      const prepared = await prepare(at, { domain, key, expectedRevision: args.expectedRevision, content })
      if (prepared !== 'conflict') uploaded = prepared.uploaded
      at.recheck()
      if (prepared === 'conflict') return { ...named, state: 'conflict' }
      const receipt = await ports.panel.commit(at.ownerId, at.agentId, {
        operationId: args.operationId, domain, key, expectedRevision: args.expectedRevision, operation, data: prepared.data,
        ...(prepared.body ? { body: prepared.body } : {}), deviceId: null,
      })
      uploaded = undefined
      at.recheck()
      const { operationId, revision, status, terminal } = receipt
      return { ...named, state: 'committed', receipt: { operationId, revision, status, ...(terminal === undefined ? {} : { terminal }) } }
    } catch (error) {
      let outcome: ReturnType<typeof writeOutcome>
      try {
        outcome = writeOutcome(error)
      } catch (refusal) {
        if (uploaded) await ports.panel.discard(at.token, at.ownerId, uploaded)
        throw refusal
      }
      // Whether an unanswered commit landed is unknown: its body stays, for the same call again to find.
      if (uploaded && outcome.state !== 'unavailable') await ports.panel.discard(at.token, at.ownerId, uploaded)
      at.recheck()
      return { ...named, ...outcome }
    }
  }
  const save = (extensionId: string, input: unknown) => change(extensionId, input, 'save', async (at, { domain, key, expectedRevision, content: text }) => {
    if (domain === 'personality') return { data: { text: splitInstructions(text).user } }
    const bytes = new TextEncoder().encode(text)
    const existing = await ports.panel.resource(at.ownerId, at.agentId, domain, key)
    at.recheck()
    if (existing && !existing.deleted_at && existing.data.kind === 'directory') throw coded('invalid', 'A folder has no content to save')
    const digest = await ports.sha256(bytes)
    if (existing && !existing.deleted_at && existing.body_item_id && existing.body_sha256 === digest) {
      return { data: existing.data, body: { itemId: existing.body_item_id, sha256: digest } }
    }
    if ((existing?.revision ?? '0') !== expectedRevision) return 'conflict'
    const data = savedData(domain, key, existing, text, new Date().toISOString())
    const body = await ports.panel.uploadBody({ token: at.token, ownerId: at.ownerId, chatId: at.chatId, label: domain === 'skills' ? 'SKILL.md' : key.split('/').pop()!, bytes })
    return { data, body, uploaded: body.itemId }
  })
  const remove = (extensionId: string, input: unknown) => change(extensionId, input, 'remove', async (at, { domain, key }) => {
    if (domain === 'personality') throw coded('invalid', 'The personality is saved, never removed')
    if (domain === 'files') {
      const existing = await ports.panel.resource(at.ownerId, at.agentId, domain, key)
      at.recheck()
      if (existing && !existing.deleted_at && existing.data.kind === 'directory') throw coded('invalid', 'Remove a folder\'s files one by one')
    }
    return { data: {} }
  })

  /** Each page's resource watches: ended when the page goes, or the authority it was granted under no longer holds. */
  const watches = new Map<string, { stop(): void }>()
  async function watch(page: PhoneBindingPage & { pageId: number }, input: unknown, hear: (watchId: string, event: AppResourceEvent) => void) {
    const { watchId, name, on } = argsOf(z.strictObject({ watchId: z.string().min(1).max(64), name: z.string(), on: z.boolean() }), input, RESOURCE_ARGS)
    const key = `${page.pageId}/${watchId}`
    if (!on) {
      watches.get(key)?.stop()
      return { name, state: 'stopped' as const }
    }
    const at = await bound(page.extensionId, name, ['resources'])
    if (!at) return { name, state: 'unbound' as const }
    watches.get(key)?.stop()
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      off()
      watches.delete(key)
      hear(watchId, { name, state: 'ended' })
    }
    const off = ports.panel.subscribe(at.ownerId, () => {
      try {
        at.recheck()
      } catch {
        end()
        return
      }
      hear(watchId, { name, state: 'changed' })
    })
    watches.set(key, { stop: () => { if (!ended) { ended = true; off(); watches.delete(key) } } })
    return { name, state: 'watching' as const }
  }
  function pageGone(pageId: number): void {
    for (const [key, held] of [...watches]) if (key.startsWith(`${pageId}/`)) held.stop()
  }

  // ── 43: the assistant's schedules (#1928), through its panel — on a phone it always lives elsewhere ───────────────
  const homeOf = (at: Bound): PanelHome => ({ ownerId: at.ownerId, assistantId: at.agentId, deviceId: at.deviceId, cloud: ports.panel.client })
  const asyncRecheck = (at: Bound) => async () => at.recheck()
  async function schedules(extensionId: string, input: unknown): Promise<AppBoundSchedules> {
    const { name } = argsOf(z.strictObject({ name: z.string() }), input, 'gugu.bindings.schedules takes the binding\'s name alone')
    const at = await boundOrUnavailable(extensionId, name, ['schedules'])
    if (at === 'unavailable') return { name, state: 'unavailable' }
    if (!at) return { name, state: 'unbound' }
    try {
      const list = await listPanelSchedules(homeOf(at), asyncRecheck(at))
      at.recheck()
      return { name, state: 'ready', schedules: list }
    } catch (error) {
      if (codeOf(error) === 'denied') throw error
      at.recheck()
      return { name, state: 'unavailable' }
    }
  }
  /** Each operation id's record on this phone (by account and App): the same id again answers it, never a second change. */
  const kept = new Map<string, { digest: string; receipt?: AppScheduleReceipt; panel?: PanelRequest }>()
  async function controlSchedule(extensionId: string, input: unknown): Promise<AppScheduleReceipt> {
    const parsed = scheduleControlSchema.safeParse(input)
    if (!parsed.success) throw coded('invalid', `controlSchedule takes the binding's name, an operationId and one change — never an agent, chat or account (${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')})`)
    const change = parsed.data
    const at = await bound(extensionId, change.name, ['schedules', 'schedules:control'])
    if (!at) throw coded('not-found', `No conversation is bound for "${change.name}" on this phone`)
    const key = JSON.stringify([at.ownerId, extensionId, change.operationId])
    const digest = JSON.stringify(Object.entries(change).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))
    const before = kept.get(key)
    if (before && before.digest !== digest) throw coded('invalid', 'This operationId was already used for another change: use a new one')
    const scheduleId = 'scheduleId' in change ? change.scheduleId : ''
    const answer = (outcome: PanelOutcome, panel?: PanelRequest): AppScheduleReceipt => {
      const receipt = { name: change.name, operationId: change.operationId, op: change.op, at: before?.receipt?.at ?? new Date().toISOString(), ...outcome } as AppScheduleReceipt
      kept.set(key, { digest, receipt, ...(panel ? { panel } : {}) })
      at.recheck()
      return receipt
    }
    if (before?.receipt && ['applied', 'conflict', 'missing', 'failed', 'superseded'].includes(before.receipt.status)) {
      at.recheck()
      return before.receipt
    }
    const home = homeOf(at)
    try {
      if (before?.panel) {
        if (before.panel.assistantId !== at.agentId) throw coded('denied', 'The bound conversation is not your private chat with your own assistant')
        return answer(await commitPanelRequest(home, before.panel, scheduleId, asyncRecheck(at)), before.panel)
      }
      const plan = await planPanelChange(home, change, asyncRecheck(at))
      at.recheck()
      if ('outcome' in plan) return answer(plan.outcome)
      kept.set(key, { digest, panel: plan.request })
      return answer(await commitPanelRequest(home, plan.request, scheduleId, asyncRecheck(at)), plan.request)
    } catch (error) {
      // Adding or retiming one is asked of the assistant, as in the person's own list: said so, as a computer says it.
      if (codeOf(error) === 'elsewhere') throw coded('invalid', (error as Error).message)
      throw error
    }
  }
  /** `onSchedulesChanged(name, fn)`'s host half: the panel's change word, heard only when the schedules differ. */
  const scheduleWatches = new Map<string, () => void>()
  async function watchSchedules(page: PhoneBindingPage & { pageId: number }, input: unknown, hear: (binding: string) => void) {
    const { name, on } = argsOf(z.strictObject({ name: z.string(), on: z.boolean() }), input, 'gugu.bindings.watchSchedules takes the binding\'s name and on')
    const key = `${page.pageId}/${name}`
    scheduleWatches.get(key)?.()
    scheduleWatches.delete(key)
    if (!on) return { name, state: 'stopped' as const }
    const at = await bound(page.extensionId, name, ['schedules'])
    if (!at) throw coded('not-found', `No conversation is bound for "${name}" on this phone`)
    const home = homeOf(at)
    let last = await panelSchedulesPrint(home).catch(() => null)
    at.recheck()
    let stopped = false
    const off = ports.panel.subscribe(at.ownerId, () => {
      void (async () => {
        if (stopped) return
        at.recheck()
        const now = await panelSchedulesPrint(home).catch(() => null)
        at.recheck()
        if (now === last || stopped) return
        last = now
        hear(name)
      })().catch(() => { stop() })
    })
    const stop = () => {
      if (stopped) return
      stopped = true
      off()
      scheduleWatches.delete(key)
    }
    scheduleWatches.set(key, stop)
    return { name, state: 'watching' as const }
  }

  // ── 46: the assistant's work list (任务) and a task's own conversation ──────────────────────────────────────────
  /** Opaque, per App, account, installation and conversation: a new one of any of them is another handle. */
  const workHandles = new Map<string, string>()
  const workHandleOf = (at: Bound, workId: string) => {
    const key = JSON.stringify([at.handle, workId])
    let handle = workHandles.get(key)
    if (!handle) workHandles.set(key, (handle = `w${ports.randomUUID().replace(/-/g, '').slice(0, 22)}`))
    return handle
  }
  function ledgerFor(at: Bound): PushedWorkLedger | null {
    const ledger = ports.layer.work()
    return ledger && ledger.ownerId === at.ownerId && ledger.assistantId === at.agentId ? ledger : null
  }
  function openHandle(at: Bound): string | null {
    const open = ports.layer.openWork()
    return open && open.ownerId === at.ownerId ? workHandleOf(at, open.workId) : null
  }
  async function work(extensionId: string, input: unknown): Promise<AppBindingWork> {
    const { name } = argsOf(z.strictObject({ name: z.string() }), input, 'gugu.bindings.work takes the binding\'s name alone')
    const at = await boundOrUnavailable(extensionId, name, ['work'])
    if (at === 'unavailable') return { name, state: 'unavailable', open: null }
    if (!at) return { name, state: 'unbound' }
    at.recheck()
    const ledger = ledgerFor(at)
    const open = openHandle(at)
    if (!ledger || ledger.state === 'none' || ledger.state === 'loading' || ledger.state === 'failed') return { name, state: 'unavailable', open }
    const items: AppWorkItem[] = ledger.rows.map((row) => ({
      handle: workHandleOf(at, row.workId), title: row.title, naming: row.naming, status: row.status, unseen: row.unseen, updatedAt: row.updatedAt,
    }))
    return { name, state: 'ready', items, stale: ledger.state === 'stale', open }
  }
  async function openWork(extensionId: string, input: unknown): Promise<void> {
    const { name, handle } = argsOf(z.strictObject({ name: z.string(), handle: z.string() }), input, 'gugu.bindings.openWork takes the binding\'s name and a handle')
    const at = await bound(extensionId, name, ['work'])
    if (!at) throw coded('not-found', `No conversation is bound for "${name}" on this phone`)
    at.recheck()
    const ledger = ledgerFor(at)
    if (!ledger) throw coded('failed', 'The work list has not been read on this phone yet: try again in a moment')
    const row = ledger.rows.find((candidate) => workHandleOf(at, candidate.workId) === handle)
    if (!row) throw coded('not-found', 'No such task in the work list')
    const actions = ports.layer.actions()
    if (!actions) throw coded('failed', 'The assistant is not open on this phone now: try again in a moment')
    actions.openWork({ workId: row.workId, sessionId: row.sessionId })
  }
  async function closeWork(extensionId: string, input: unknown): Promise<void> {
    const { name } = argsOf(z.strictObject({ name: z.string() }), input, 'gugu.bindings.closeWork takes the binding\'s name alone')
    declared(installed(extensionId), name, 'work')
    if (ports.layer.openWork()?.ownerId === signedIn().ownerId) ports.layer.actions()?.openWork(null)
  }

  // ── 44: the assistant ───────────────────────────────────────────────────────────────────────────────────────────
  /** While the account has no assistant, an App granted the action sees the snapshot without one (none bound yet). */
  function noAssistant(extensionId: string, name: string, action: 'assistant-status' | 'assistant-open') {
    const { ownerId } = signedIn()
    declared(installed(extensionId), name, action)
    const shown = ports.layer.status()
    return shown?.ownerId === ownerId && shown.status.assistant !== 'found' ? { ownerId, status: withoutAssistant(shown.status) } : null
  }
  /** Whether one of the phone's own screens is drawn over this App's page in the layer now (#1925 `hostPage`). */
  const hostPageOver = (extensionId: string, ownerId: string) => {
    const shown = ports.layer.shown()
    return shown?.extensionId === extensionId && shown.ownerId === ownerId && shown.hostPage
  }
  async function readStatus(extensionId: string, name: string): Promise<AppAssistantRead> {
    const none = noAssistant(extensionId, name, 'assistant-status')
    if (none) return { name, state: 'ready', status: none.status, hostPage: hostPageOver(extensionId, none.ownerId) }
    const at = await boundOrUnavailable(extensionId, name, ['assistant-status'])
    if (at === 'unavailable') return { name, state: 'unavailable' }
    if (!at) return { name, state: 'unbound' }
    const shown = ports.layer.status()
    if (!shown || shown.ownerId !== at.ownerId) return { name, state: 'unavailable' }
    return { name, state: 'ready', status: shown.status.assistant === 'found' ? shown.status : withoutAssistant(shown.status), hostPage: hostPageOver(extensionId, at.ownerId) }
  }
  async function assistantStatus(extensionId: string, input: unknown): Promise<AppAssistantRead> {
    const { name } = argsOf(z.strictObject({ name: z.string() }), input, 'gugu.assistant.status takes the binding\'s name alone')
    return readStatus(extensionId, name)
  }
  /** `assistant.open(name, screen)`, in a click: the phone's own screen for it, or `unsupported` (PHONE_ASSISTANT_SCREENS). */
  async function assistantOpen(extensionId: string, input: unknown): Promise<undefined | AppBindingUnsupported> {
    const { name, screen } = argsOf(z.strictObject({ name: z.string(), screen: z.enum(ASSISTANT_SCREENS) }), input,
      `gugu.assistant.open takes the binding's name and one of ${ASSISTANT_SCREENS.join(', ')}`)
    const target = PHONE_ASSISTANT_SCREENS[screen]
    const none = screen === 'setup' ? noAssistant(extensionId, name, 'assistant-open') : null
    if (!none) {
      const at = await bound(extensionId, name, ['assistant-open'])
      if (!at) throw coded('not-found', `No conversation is bound for "${name}" on this phone`)
      at.recheck()
    }
    if (!target) return unsupportedHere(name)
    const actions = ports.layer.actions()
    if (!actions) throw coded('failed', 'The assistant is not open on this phone now: try again in a moment')
    actions.open(target)
    return undefined
  }
  /** `assistant.advanceSetup`: the steps after the home are a computer's; a phone answers `unsupported` once it may ask. */
  async function assistantAdvanceSetup(extensionId: string, input: unknown): Promise<AppBindingUnsupported> {
    const { name } = argsOf(z.strictObject({ name: z.string(), next: z.enum(['ready', 'done']) }), input,
      'gugu.assistant.advanceSetup takes the binding\'s name and "ready" or "done"')
    declared(installed(extensionId), name, 'assistant-open')
    return unsupportedHere(name)
  }
  /**
   * `assistant.connect(name, id)` (44, the setup's connect step): a computer's step; on a phone the services are connected
   * from 资料 (`open(…, "connected-apps")`) — `unsupported`, once the App may ask.
   */
  async function assistantConnect(extensionId: string, input: unknown): Promise<AppBindingUnsupported> {
    const { name } = argsOf(z.strictObject({ name: z.string(), id: z.string().max(100) }), input,
      'gugu.assistant.connect takes the binding\'s name and a connector id from status.connectors')
    declared(installed(extensionId), name, 'assistant-open')
    return unsupportedHere(name)
  }
  /**
   * `assistant.rename(name, text)` (44, `assistant:rename`, in a click): the bound assistant renamed by the built-in field's
   * rule (`renameCheck`, against the name the layer shows) the way 自定义 saves a name. A closed answer.
   */
  async function assistantRename(extensionId: string, input: unknown): Promise<AssistantRenameResult> {
    const { name, text } = argsOf(z.strictObject({ name: z.string(), text: z.string().max(1000) }), input,
      'gugu.assistant.rename takes the binding\'s name and the new name')
    const at = await bound(extensionId, name, ['assistant-rename'])
    if (!at) throw coded('not-found', `No conversation is bound for "${name}" on this phone`)
    const shown = ports.layer.status()
    if (shown?.ownerId !== at.ownerId || shown.status.assistant !== 'found') throw coded('failed', 'The assistant is not shown on this phone yet: try again in a moment')
    const check = renameCheck(text, shown.status.name)
    if ('result' in check) return check.result
    try {
      await ports.renameAssistant(at.agentId, check.name)
      at.recheck()
    } catch (error) {
      if (codeOf(error) === 'denied') throw error
      return 'failed'
    }
    return 'renamed'
  }
  // ── 50: managing 给助理的资料 and voice notes ─────────────────────────────────────────────────────────────────────
  const FILES_ROOT = ASSISTANT_PANEL_PATHS.resourcesDir
  const VOICE_ROOT = `${ASSISTANT_PANEL_PATHS.memoryDir}/${VOICE_NOTES_DIR}`
  const MANAGE_ARGS = 'gugu.bindings takes the binding\'s name and the key, folder or new name it changes, never an owner, agent, chat or path on disk'
  const receiptOf = ({ operationId, revision, status, terminal }: AssistantPanelReceipt) =>
    ({ operationId, revision, status, ...(terminal === undefined ? {} : { terminal }) })
  type Panel = { files: ReturnType<typeof createAssistantPanelFiles>; receipts: AssistantPanelReceipt[] }
  /** The assistant pages' own store view (the built-in pages' `write` / `remove`), as this person, every commit's receipt kept. */
  function panelOf(at: Bound): Panel {
    const receipts: AssistantPanelReceipt[] = []
    const client = ports.panel.client
    const cloud: AssistantPanelClient = {
      ...client,
      commit: async (assistant, change) => {
        const receipt = await client.commit(assistant, change)
        receipts.push(receipt)
        return receipt
      },
    }
    const files = createAssistantPanelFiles({
      assistantId: at.agentId, deviceId: at.deviceId, ownerId: at.ownerId, cloud,
      assertCurrent: at.recheck,
      readBody: (item) => ports.panel.readBody(item, { token: at.token, ownerId: at.ownerId, chatId: at.chatId, maxBytes: DEFAULT_TEXT_MAX_BYTES }),
      upload: (label, bytes) => ports.panel.uploadBody({ token: at.token, ownerId: at.ownerId, chatId: at.chatId, label, bytes }),
      discard: (itemId) => ports.panel.discard(at.token, at.ownerId, itemId),
      changed: () => undefined,
    })
    return { files, receipts }
  }
  /** One managing call under the binding's authority (an App of API 50 only): `unbound`, `unavailable` with its class, a refusal thrown. */
  async function under<T extends object>(extensionId: string, name: string, needs: readonly ConversationBindingAction[], domain: 'files' | 'voice-notes',
    use: (at: Bound, panel: Panel) => Promise<T>): Promise<T | { name: string; state: 'unbound' } | ({ name: string } & Unavailable)> {
    if (installed(extensionId).manifest.apiVersion < RESOURCES_MANAGEMENT_API_VERSION) throw coded('denied', `This call needs apiVersion ${RESOURCES_MANAGEMENT_API_VERSION}`)
    const at = await bound(extensionId, name, needs, domain).catch((error: unknown) => {
      if (codeOf(error) === 'failed') return unavailable(reasonOf(error))
      throw error
    })
    if (!at) return { name, state: 'unbound' }
    if ('state' in at) return { name, ...at }
    try {
      const value = await use(at, panelOf(at))
      at.recheck()
      return value
    } catch (error) {
      if (codeOf(error) === 'invalid-path' || codeOf(error) === '22023') throw coded('invalid', 'The resource store does not take this name')
      const outcome = refusedOrUnavailable(error)
      at.recheck()
      return { name, ...outcome }
    }
  }
  /**
   * `gugu.bindings.upload(name, { folder? })` (50, `resources:write` listing `files`, in a click): the phone's own picker, each
   * file the built-in page's rules take (50 MB, no video, audio or archive) written as that page wrote it, the others named back.
   */
  async function upload(extensionId: string, input: unknown): Promise<AppUploadAnswer> {
    const args = argsOf(uploadArgsSchema, input, MANAGE_ARGS)
    const folder = args.folder ? resourceKeyOf('files', args.folder) : ''
    return under(extensionId, args.name, ['resources', 'resources:write'], 'files', async (at, panel): Promise<AppUploadAnswer> => {
      const picked = await ports.pickFiles()
      at.recheck()
      if (!picked) return { name: args.name, state: 'cancelled' }
      const uploaded: Extract<AppUploadAnswer, { state: 'done' }>['uploaded'] = []
      const refused: Extract<AppUploadAnswer, { state: 'done' }>['refused'] = []
      for (const file of picked) {
        const rule = resourceRejection({ name: file.name, size: file.size, type: file.contentType })
        if (rule) { refused.push({ name: file.name, why: rule === 'too_large' ? 'too-large' : 'unsupported' }); continue }
        const key = folder ? `${folder}/${file.name}` : file.name
        try {
          resourceKeyOf('files', key)
        } catch {
          refused.push({ name: file.name, why: 'not-saved' })
          continue
        }
        const before = panel.receipts.length
        try {
          await panel.files.write(`${FILES_ROOT}/${key}`, await file.read(), file.contentType || 'application/octet-stream')
          const receipt = panel.receipts.slice(before).at(-1)
          if (receipt) uploaded.push({ key, name: file.name, receipt: receiptOf(receipt) })
          else refused.push({ name: file.name, why: 'not-saved' })
        } catch (error) {
          if (codeOf(error) === 'denied') throw error
          refusedOrUnavailable(error)
          refused.push({ name: file.name, why: 'not-saved' })
        }
        at.recheck()
      }
      return { name: args.name, state: 'done', uploaded, refused }
    })
  }
  /** `gugu.bindings.removeVoiceNote(name, key)` (50, `voice-notes:manage`, in a click): the note and all of it, once the person said yes. */
  async function removeVoiceNote(extensionId: string, input: unknown): Promise<AppRemoveAllAnswer> {
    const args = argsOf(voiceNoteArgsSchema, input, MANAGE_ARGS)
    const key = resourceKeyOf('voice-notes', args.key)
    if (key.includes('/')) throw coded('invalid', 'key is a voice note\'s id (its noteId), without "/"')
    const answer = await under(extensionId, args.name, ['resources', VOICE_NOTES_MANAGE_ACTION], 'voice-notes', async (at, panel): Promise<AppRemoveAllAnswer> => {
      const snapshot = await panel.files.snapshot()
      at.recheck()
      const rows = snapshot.items.filter((item) => item.domain === 'voice-notes' && !item.deleted_at && (item.resource_key === key || item.resource_key.startsWith(`${key}/`)))
      if (rows.length === 0) return { name: args.name, key, state: 'missing' }
      const meta = await panel.files.text(`${VOICE_ROOT}/${key}/${VOICE_NOTE_META_FILE}`).catch(() => null)
      at.recheck()
      const yes = await ports.confirmRemoval({ kind: 'voice-note', title: parseVoiceNoteMeta(meta ?? '')?.title ?? null })
      at.recheck()
      if (!yes) return { name: args.name, key, state: 'cancelled' }
      await panel.files.remove(`${VOICE_ROOT}/${key}`, true)
      return { name: args.name, key, state: 'committed', receipts: panel.receipts.map(receiptOf) }
    })
    return 'key' in answer ? answer : { ...answer, key }
  }
  /**
   * The rest of API 50 on a phone — 给助理的资料's createFolder / rename / removeFolder and a voice note's transcribe / export —
   * is not done from a phone (its own pages never had them: 新建 and 改名 are a computer's, transcription runs on a computer,
   * a phone has no save dialog): each answers `unsupported` once its arguments and grant are checked; nothing changes.
   */
  async function manage(extensionId: string, method: (typeof MANAGE_VERBS)[number], input: unknown): Promise<AppUploadAnswer | AppRemoveAllAnswer | AppBindingUnsupported> {
    if (method === 'bindingsUpload') return upload(extensionId, input)
    if (method === 'bindingsRemoveVoiceNote') return removeVoiceNote(extensionId, input)
    const files = method === 'bindingsCreateFolder' || method === 'bindingsRename' || method === 'bindingsRemoveFolder'
    const schema = method === 'bindingsRename' ? renameArgsSchema : files ? folderArgsSchema : voiceNoteArgsSchema
    const { name } = argsOf(schema, input, MANAGE_ARGS)
    const app = installed(extensionId)
    if (files) declared(app, name, 'resources:write', 'files')
    else declared(app, name, VOICE_NOTES_MANAGE_ACTION)
    return unsupportedHere(name)
  }
  /**
   * `gugu.voiceNote.*` (47, `voice-notes:record`): on a phone the assistant's 聊天 records with the phone's own recorder
   * (PhoneVoiceBar); an App does not drive it there — every verb answers `unsupported`, once the App may ask, and a watch
   * never fires. The arguments are checked as a computer checks them (voice-note-session.ts).
   */
  async function voiceNote(extensionId: string, method: (typeof VOICE_NOTE_VERBS)[number], input: unknown): Promise<AppBindingUnsupported> {
    const schema = method === 'voiceNoteStart' ? voiceNoteStartSchema : method === 'voiceNoteRetry' ? voiceNoteRetrySchema
      : method === 'voiceNoteWatch' ? voiceNoteWatchSchema : voiceNoteNameSchema
    const { name } = argsOf(schema, input, `gugu.voiceNote takes the binding's name${method === 'voiceNoteRetry' ? ' and a job handle' : ''}`)
    declared(installed(extensionId), name, VOICE_NOTE_RECORD_ACTION)
    return unsupportedHere(name)
  }
  /**
   * `assistant.figure(name, figure)` (44): on a phone the layer's own header already draws the assistant's face; nothing is
   * laid over the App's page there — `unsupported`, once the App may ask.
   */
  async function assistantFigure(extensionId: string, input: unknown): Promise<AppBindingUnsupported> {
    const { name } = argsOf(z.strictObject({ name: z.string(), figure: assistantFigureSchema.nullable() }), input,
      'gugu.assistant.figure takes the binding\'s name and { x, y, size } (CSS pixels of the page), or null')
    declared(installed(extensionId), name, 'assistant-status')
    return unsupportedHere(name)
  }

  /**
   * A page the person works hears, while it is up: its surface each time the layer moves (`bindingSurface`), and the
   * assistant each time the layer's snapshot changes (`assistantChanged`) — each answered as a read would answer it now.
   */
  function attach(page: PhoneBindingPage & { pageId: number }, deliver: (event: ExtensionHostEvent) => void): () => void {
    let disposed = false
    // A page of an App without a binding hears none of it; nothing about the App is asked beyond its manifest.
    let app: PhoneInstalledApp | null = null
    try {
      app = ports.installed(page.extensionId)
    } catch {
      app = null
    }
    if (!app?.manifest.permissions?.bindings?.length) return () => { disposed = true; pageGone(page.pageId) }
    const surfaceName = app?.manifest.contributes.conversationSurface?.binding
    const binding = app?.manifest.permissions?.bindings?.[0]
    let lastSurface = ''
    const tellSurface = () => {
      if (!surfaceName || !binding?.actions.includes('surface')) return
      void surfaceOf(page, surfaceName).catch(() => ({ name: surfaceName, state: 'unbound' } as const)).then((now) => {
        const key = JSON.stringify(now)
        if (disposed || key === lastSurface) return
        lastSurface = key
        deliver({ type: 'bindingSurface', surface: now as Extract<ExtensionHostEvent, { type: 'bindingSurface' }>['surface'] })
      })
    }
    // What the person asked of this page through the layer (the recording bar's note, the 自定义 card): told once, with the
    // surface as it is then, only while the page is bound there; never in an answer.
    const tellIntent = (intent: AppSurfaceIntent) => {
      if (!surfaceName || !binding?.actions.includes('surface')) return
      void surfaceOf(page, surfaceName).catch(() => null).then((now) => {
        if (disposed || !now || now.state !== 'bound') return
        lastSurface = JSON.stringify(now)
        deliver({ type: 'bindingSurface', surface: { ...now, intent } as Extract<ExtensionHostEvent, { type: 'bindingSurface' }>['surface'] })
      })
    }
    let lastStatus = ''
    const tellStatus = () => {
      if (!binding?.actions.includes('assistant-status')) return
      void readStatus(page.extensionId, binding.name).catch(() => null).then((now) => {
        if (disposed || !now || now.state === 'unavailable') return
        const key = JSON.stringify(now)
        if (key === lastStatus) return
        lastStatus = key
        deliver(now.state === 'ready'
          ? { type: 'assistantChanged', name: now.name, state: 'ready', status: now.status as AppAssistantStatus, hostPage: now.hostPage }
          : { type: 'assistantChanged', name: now.name, state: 'unbound' })
      })
    }
    let lastWork = ''
    const tellWork = () => {
      if (!binding?.actions.includes('work')) return
      void work(page.extensionId, { name: binding.name }).catch(() => null).then((now) => {
        if (disposed || !now) return
        const key = JSON.stringify(now)
        if (key === lastWork) return
        lastWork = key
        deliver({ type: 'bindingWork', work: now })
      })
    }
    // A host page opening or closing over this page moves `hostPage`: told with the assistant.
    const offShown = ports.layer.onShown(() => { tellSurface(); tellStatus() })
    const offStatus = ports.layer.onStatus(tellStatus)
    const offWork = ports.layer.onWork(tellWork)
    const offIntent = ports.layer.onIntent(tellIntent)
    return () => {
      disposed = true
      offIntent()
      offShown()
      offStatus()
      offWork()
      pageGone(page.pageId)
      for (const [key, stop] of [...scheduleWatches]) if (key.startsWith(`${page.pageId}/`)) stop()
    }
  }

  return {
    get, list, read, draft, surface, setPanel, resources, resource, save, remove, watch, pageGone,
    schedules, controlSchedule, watchSchedules, work, openWork, closeWork,
    assistantStatus, assistantOpen, assistantAdvanceSetup, assistantRename, assistantFigure, assistantConnect, voiceNote, manage, attach,
  }
}
export type PhoneBindings = ReturnType<typeof createPhoneBindings>

/** API 50's managing verbs: upload and removeVoiceNote done on a phone, the rest answered `unsupported`. */
const MANAGE_VERBS = ['bindingsUpload', 'bindingsCreateFolder', 'bindingsRename', 'bindingsRemoveFolder', 'bindingsTranscribeVoiceNote', 'bindingsRemoveVoiceNote', 'bindingsExportVoiceNote'] as const

/** The voice-note recorder's verbs (47): answered `unsupported` on a phone. */
const VOICE_NOTE_VERBS = ['voiceNoteStart', 'voiceNotePause', 'voiceNoteResume', 'voiceNoteStop', 'voiceNoteRetry', 'voiceNoteOpenMicSettings', 'voiceNoteStatus', 'voiceNoteWatch'] as const

/** The verbs the binding host answers on a phone (the rest of phoneAppHost's switch is not this). */
export const PHONE_BINDING_VERBS = [
  'bindingsGet', 'bindingsList', 'bindingsRead', 'bindingsSurface', 'bindingsSurfacePanel',
  'bindingsResources', 'bindingsResource', 'bindingsWatch', 'bindingsSave', 'bindingsRemove',
  'bindingsSchedules', 'bindingsSchedulesWatch', 'bindingsScheduleControl', 'bindingsWork', 'bindingsOpenWork', 'bindingsCloseWork',
  'assistantStatus', 'assistantOpen', 'assistantAdvanceSetup', 'assistantRename', 'assistantFigure', 'assistantConnect', ...VOICE_NOTE_VERBS, ...MANAGE_VERBS,
] as const

/** One call of those, answered; `hear` carries a resource watch's events to the page. */
export function answerPhoneBinding(
  bindings: PhoneBindings,
  method: string,
  page: PhoneBindingPage & { pageId: number },
  args: Record<string, unknown>,
  hear: (watchId: string, event: AppResourceEvent) => void,
  heardSchedules: (binding: string) => void = () => undefined,
): Promise<unknown> | null {
  switch (method) {
    case 'bindingsGet': return bindings.get(page.extensionId, args)
    case 'bindingsList': return bindings.list(page.extensionId, args)
    case 'bindingsRead': return bindings.read(page.extensionId, args)
    case 'bindingsSurface': return bindings.surface(page, args)
    case 'bindingsSurfacePanel': return bindings.setPanel(page, args)
    case 'bindingsResources': return bindings.resources(page.extensionId, args)
    case 'bindingsResource': return bindings.resource(page.extensionId, args)
    case 'bindingsWatch': return bindings.watch(page, args, hear)
    case 'bindingsSave': return bindings.save(page.extensionId, args)
    case 'bindingsRemove': return bindings.remove(page.extensionId, args)
    case 'bindingsSchedules': return bindings.schedules(page.extensionId, args)
    case 'bindingsSchedulesWatch': return bindings.watchSchedules(page, args, heardSchedules)
    case 'bindingsScheduleControl': return bindings.controlSchedule(page.extensionId, args)
    case 'bindingsWork': return bindings.work(page.extensionId, args)
    case 'bindingsOpenWork': return bindings.openWork(page.extensionId, args)
    case 'bindingsCloseWork': return bindings.closeWork(page.extensionId, args)
    case 'assistantStatus': return bindings.assistantStatus(page.extensionId, args)
    case 'assistantOpen': return bindings.assistantOpen(page.extensionId, args)
    case 'assistantAdvanceSetup': return bindings.assistantAdvanceSetup(page.extensionId, args)
    case 'assistantRename': return bindings.assistantRename(page.extensionId, args)
    case 'assistantFigure': return bindings.assistantFigure(page.extensionId, args)
    case 'assistantConnect': return bindings.assistantConnect(page.extensionId, args)
    case 'bindingsUpload': case 'bindingsCreateFolder': case 'bindingsRename': case 'bindingsRemoveFolder':
    case 'bindingsTranscribeVoiceNote': case 'bindingsRemoveVoiceNote': case 'bindingsExportVoiceNote':
      return bindings.manage(page.extensionId, method, args)
    case 'voiceNoteStart': case 'voiceNotePause': case 'voiceNoteResume': case 'voiceNoteStop': case 'voiceNoteRetry':
    case 'voiceNoteOpenMicSettings': case 'voiceNoteStatus': case 'voiceNoteWatch':
      return bindings.voiceNote(page.extensionId, method, args)
    default: return null
  }
}
