import { z } from 'zod'
import type { AssistantPanelCommit, AssistantPanelDomain, AssistantPanelItem, AssistantPanelReceipt, AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import { splitInstructions } from '@gugu/core/shared/assistantInstructions'
import {
  READABLE_RESOURCE_DOMAINS, WRITABLE_RESOURCE_DOMAINS, appResourceOf, resourceChangeSchema, resourceDomainOf, resourceKeyOf,
  type AppResourceEvent, type AppResourceList, type AppResourceRead, type AppResourceWrite, type ReadableResourceDomain, type ResourceBindingAction,
} from '../../session/shared/extensions/agent-resources'
import { DEFAULT_TEXT_MAX_BYTES, type AppFileEntry } from '../../session/shared/extensions/app-runtime-protocol'
import type { PathText } from '../../session/shared/extensions/app-files-core'
import { dispatchCallOf } from '../../session/shared/extensions/app-dispatch-core'
import { ASSISTANT_SCREENS, withoutAssistant, type AppAssistantRead, type AppAssistantStatus } from '../../session/shared/extensions/assistant-binding'
import { assistantLayerEntry, type AssistantAppInstall } from '../../session/shared/extensions/assistant-entry'
import { domainState, refusedOrUnavailable, savedData, writeOutcome } from '../../session/shared/extensions/bound-resources-core'
import type { ExtensionHostEvent } from '../../session/shared/extensions/bridge-protocol'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { PHONE_ASSISTANT_SCREENS, PHONE_SURFACE_SECTIONS, unsupportedHere, type AppBindingUnsupported, type PhoneSurfaceSection } from '../../session/shared/extensions/phone-binding'
import {
  BINDING_ACTION_CAPABILITY, boundEntryOf, boundPathOf,
  type AppBindingSurface, type AppBoundList, type AppBoundRead, type AppUnreadBinding, type ConversationBindingAction,
} from '../../session/shared/extensions/unread-binding'
import type { PhoneLayerActions, PhoneLayerShown, PhoneLayerStatus } from './phoneAssistantLayer'

/**
 * The conversation binding on a phone (API 48, phone-binding.ts): the desktop main process's verbs (electron
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
  personalAssistant(token: string, ownerId: string): Promise<{ agentId: string; chatId: string } | null>
  /** What the chat is and who is in it now. `failed`: unknown. */
  conversation(token: string, chatId: string): Promise<{ kind: string | null; members: string[] }>
  files: {
    list(chatId: string, folder: string | undefined): Promise<(AppFileEntry & { chat?: string })[]>
    read(chatId: string, path: string, maxBytes: number): Promise<PathText>
    resourceChat(chatId: string): Promise<string>
  }
  /** Words into that chat's composer (the layer's conversation comes up); nothing is sent. */
  draft(chatId: string, text: string): Promise<void>
  panel: {
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
  }
  randomUUID(): string
  sha256(bytes: Uint8Array): Promise<string>
}

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
  return app ? JSON.stringify([app.manifest.id, app.manifest.version, app.manifestDigest, app.origin ?? null, app.marketSource?.repo ?? null, app.enabled, app.activeVariant]) : 'none'
}

type Bound = { ownerId: string; token: string; chatId: string; agentId: string; handle: string; recheck(): void }

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
    return { ownerId, token, chatId: assistant.chatId, agentId: assistant.agentId, handle: handleOf(JSON.stringify([ownerId, stamp, assistant.chatId])), recheck }
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
  async function draft(extensionId: string, args: Record<string, unknown>): Promise<{ to: { binding: string } }> {
    const call = dispatchCallOf(args)
    if (!call.draft || !call.to || !('binding' in call.to)) throw coded('invalid', 'A binding\'s conversation takes only a draft: { draft: true, to: { binding } }')
    const name = call.to.binding
    const at = await bound(extensionId, name, ['draft'])
    if (!at) throw coded('not-found', `No conversation is bound for "${name}" on this phone`)
    at.recheck()
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
    return { name, state: 'bound', layout: 'phone', section: shown.section }
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
    if (now.layout === 'phone' && now.section !== args.section) actions.move(args.section as PhoneSurfaceSection)
    return { name: args.name, state: 'bound', layout: 'phone', section: args.section }
  }

  // ── 42: the assistant's resources ───────────────────────────────────────────────────────────────────────────────
  function readableDomainOf(value: unknown): ReadableResourceDomain {
    const domain = resourceDomainOf(value)
    if (!(READABLE_RESOURCE_DOMAINS as readonly string[]).includes(domain)) throw coded('denied', `The ${domain} resources are never granted to an App`)
    return domain as ReadableResourceDomain
  }
  async function withResources<T>(extensionId: string, name: string, domain: string, use: (at: Bound) => Promise<T>): Promise<T | 'unbound' | 'unavailable'> {
    const at = await boundOrUnavailable(extensionId, name, ['resources'], domain)
    if (at === 'unavailable' || at === null) return at ?? 'unbound'
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
      if (readable.state !== 'ready') return { ...named, state: readable.state }
      return { ...named, state: 'ready', revision: snapshot.revision, resources: readable.items.map((item) => appResourceOf(domain, item)) }
    })
    return typeof answer === 'string' ? { ...named, state: answer } : answer
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
      if (readable && readable.state !== 'ready') return { ...named, state: readable.state }
      if (!item) return { ...named, state: 'missing', revision: '0' }
      if (item.deleted_at) return { ...named, state: 'missing', revision: item.revision, deleted: true }
      if (item.stale_at) return { ...named, state: 'unavailable' }
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
    return typeof answer === 'string' ? { ...named, state: answer } : answer
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
    const at = await boundOrUnavailable(extensionId, args.name, ['resources', 'resources:write'], domain)
    if (at === 'unavailable') return { ...named, state: 'unavailable' }
    if (!at) return { ...named, state: 'unbound' }
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
      if (uploaded && outcome !== 'unavailable') await ports.panel.discard(at.token, at.ownerId, uploaded)
      at.recheck()
      return { ...named, state: outcome }
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

  // ── 44: the assistant ───────────────────────────────────────────────────────────────────────────────────────────
  /** While the account has no assistant, an App granted the action sees the snapshot without one (none bound yet). */
  function noAssistant(extensionId: string, name: string, action: 'assistant-status' | 'assistant-open') {
    const { ownerId } = signedIn()
    declared(installed(extensionId), name, action)
    const shown = ports.layer.status()
    return shown?.ownerId === ownerId && shown.status.assistant !== 'found' ? { ownerId, status: withoutAssistant(shown.status) } : null
  }
  async function readStatus(extensionId: string, name: string): Promise<AppAssistantRead> {
    const none = noAssistant(extensionId, name, 'assistant-status')
    if (none) return { name, state: 'ready', status: none.status }
    const at = await boundOrUnavailable(extensionId, name, ['assistant-status'])
    if (at === 'unavailable') return { name, state: 'unavailable' }
    if (!at) return { name, state: 'unbound' }
    const shown = ports.layer.status()
    if (!shown || shown.ownerId !== at.ownerId) return { name, state: 'unavailable' }
    return { name, state: 'ready', status: shown.status.assistant === 'found' ? shown.status : withoutAssistant(shown.status) }
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
   * A page the person works hears, while it is up: its surface each time the layer moves (`bindingSurface`), and the
   * assistant each time the layer's snapshot changes (`assistantChanged`) — each answered as a read would answer it now.
   */
  function attach(page: PhoneBindingPage & { pageId: number }, deliver: (event: ExtensionHostEvent) => void): () => void {
    let disposed = false
    const app = ports.installed(page.extensionId)
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
    let lastStatus = ''
    const tellStatus = () => {
      if (!binding?.actions.includes('assistant-status')) return
      void readStatus(page.extensionId, binding.name).catch(() => null).then((now) => {
        if (disposed || !now || now.state === 'unavailable') return
        const key = JSON.stringify(now)
        if (key === lastStatus) return
        lastStatus = key
        deliver(now.state === 'ready'
          ? { type: 'assistantChanged', name: now.name, state: 'ready', status: now.status as AppAssistantStatus }
          : { type: 'assistantChanged', name: now.name, state: 'unbound' })
      })
    }
    const offShown = ports.layer.onShown(tellSurface)
    const offStatus = ports.layer.onStatus(tellStatus)
    return () => {
      disposed = true
      offShown()
      offStatus()
      pageGone(page.pageId)
    }
  }

  return {
    get, list, read, draft, surface, setPanel, resources, resource, save, remove, watch, pageGone,
    assistantStatus, assistantOpen, assistantAdvanceSetup, attach,
  }
}
export type PhoneBindings = ReturnType<typeof createPhoneBindings>

/** The verbs the binding host answers on a phone (the rest of phoneAppHost's switch is not this). */
export const PHONE_BINDING_VERBS = [
  'bindingsGet', 'bindingsList', 'bindingsRead', 'bindingsSurface', 'bindingsSurfacePanel',
  'bindingsResources', 'bindingsResource', 'bindingsWatch', 'bindingsSave', 'bindingsRemove',
  'assistantStatus', 'assistantOpen', 'assistantAdvanceSetup',
] as const

/** One call of those, answered; `hear` carries a resource watch's events to the page. */
export function answerPhoneBinding(
  bindings: PhoneBindings,
  method: string,
  page: PhoneBindingPage & { pageId: number },
  args: Record<string, unknown>,
  hear: (watchId: string, event: AppResourceEvent) => void,
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
    case 'assistantStatus': return bindings.assistantStatus(page.extensionId, args)
    case 'assistantOpen': return bindings.assistantOpen(page.extensionId, args)
    case 'assistantAdvanceSetup': return bindings.assistantAdvanceSetup(page.extensionId, args)
    default: return null
  }
}
