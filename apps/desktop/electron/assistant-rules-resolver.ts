// #1931 Which personal-assistant product rules the host uses: the trusted assistant App's, else the last good copy the
// host kept of them (started, when there is none yet, from the copy packaged with this release). The open repository
// carries no words of its own: with neither, the answer is `none`, and nothing that needs the rules proceeds — a session
// start waits for them (`available`), a host refresh leaves the assistant's files as they are.
//
// Cheap to read: an App version's folder is read and validated once (keyed by version, manifest digest and folder), not
// per turn. `refresh` looks at the installed App again — at each assistant session start, at setup, and whenever the
// installed App changes (`appChanged`: installed, updated, switched on or off, removed) — and `current` answers from memory
// while nothing changed since that look. Each answer is one frozen snapshot that the next
// refresh replaces whole: a render that took it keeps it to the end, so a new version takes effect between renders,
// never inside one.
import type { AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { readDeclaredAssistantRules } from './assistant-product-rules'
import type { AssistantRulesLastGoodStore, LastGoodAssistantRules } from './assistant-rules-last-good'
import { assistantRulesDistrust, ASSISTANT_RULES_TRUST, type AssistantRulesProvider, type AssistantRulesTrustCondition } from './assistant-rules-trust'

export type AssistantRulesSource = 'app' | 'last-good'

export interface ResolvedAssistantRules {
  readonly source: AssistantRulesSource
  readonly rules: AssistantProductRules
  /** The assistant App version the rules came from. */
  readonly appVersion: string
}

/** No rules here: no trusted App with valid rules, no kept copy, none packaged. */
export interface NoAssistantRules {
  readonly source: 'none'
  readonly rules: null
  readonly appVersion: null
}

export type AssistantRulesAnswer = ResolvedAssistantRules | NoAssistantRules

export const NO_ASSISTANT_RULES: NoAssistantRules = Object.freeze({ source: 'none', rules: null, appVersion: null })

export interface AssistantRulesResolverDeps {
  /** The installed App that may provide the rules, or null. Read at each refresh only. */
  provider(): AssistantRulesProvider | null | Promise<AssistantRulesProvider | null>
  lastGood: AssistantRulesLastGoodStore
  /** The copy packaged with this release, to start the kept copy from when there is none (an upgrade made offline). */
  seed?(): Promise<LastGoodAssistantRules | null>
  trust?: readonly AssistantRulesTrustCondition[]
  /** Said once for each thing that went wrong (an App version, the kept copy): the next refresh does not repeat it. */
  warn(message: string, detail: Record<string, unknown>): void
}

export interface AssistantRulesResolver {
  /** Looks at the installed App again and answers with the rules to use from now on. One at a time: a call while one runs gets that one. */
  refresh(): Promise<AssistantRulesAnswer>
  /** The rules in use: from memory once anything was resolved in this process; the first call resolves. */
  current(): Promise<AssistantRulesAnswer>
  /** The rules in use, once there are any: waits (for the next refresh that finds them) while there are none. */
  available(): Promise<ResolvedAssistantRules>
  /** Told each time the answer changes (none → rules, one version → another). */
  subscribe(listener: (answer: AssistantRulesAnswer) => void): () => void
  /**
   * The installed App changed — installed, updated, a fork switched, switched on or off, removed: no answer from before is
   * given again (a look that started before it is not joined), and it is looked at now, so trust is decided again and the
   * kept copy and the windows follow without a restart. A running session keeps the snapshot it started with.
   */
  appChanged(): Promise<AssistantRulesAnswer>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createAssistantRulesResolver(deps: AssistantRulesResolverDeps): AssistantRulesResolver {
  let snapshot: AssistantRulesAnswer | null = null
  /** Each change of the installed App starts a new look; an answer counts only for the look it was resolved in. */
  let look = 0
  let snapshotLook = -1
  let running: { look: number; answer: Promise<AssistantRulesAnswer> } | null = null
  const waiting: ((answer: ResolvedAssistantRules) => void)[] = []
  const listeners = new Set<(answer: AssistantRulesAnswer) => void>()
  /** The App version read last, and its rules — null when its folder was not valid (not read again until it changes). */
  let read: { key: string; rules: AssistantProductRules | null } | null = null
  /** The kept copy: undefined until looked at, then what was found (or written) since. */
  let kept: LastGoodAssistantRules | null | undefined
  const said = new Set<string>()
  const warnOnce = (key: string, message: string, detail: Record<string, unknown>) => {
    if (said.has(key)) return
    said.add(key)
    deps.warn(message, detail)
  }

  async function lastGood(): Promise<LastGoodAssistantRules | null> {
    if (kept === undefined) {
      try { kept = await deps.lastGood.read() }
      catch (error) {
        warnOnce('last-good', 'the kept copy of the assistant rules is not valid; it is not used', { error: messageOf(error) })
        kept = null
      }
      if (!kept && deps.seed) {
        try {
          const seeded = await deps.seed()
          if (seeded) {
            kept = seeded
            try { await deps.lastGood.write(seeded) }
            catch (error) { warnOnce('keep:seed', 'the packaged assistant rules could not be kept as the last good copy', { error: messageOf(error) }) }
          }
        } catch (error) {
          warnOnce('seed', 'the assistant rules packaged with this release are not valid; they are not used', { error: messageOf(error) })
        }
      }
    }
    return kept
  }

  async function fromApp(): Promise<ResolvedAssistantRules | null> {
    let provider: AssistantRulesProvider | null
    try { provider = await deps.provider() }
    catch (error) {
      warnOnce(`provider:${messageOf(error)}`, 'the assistant App could not be read; its rules are not used', { error: messageOf(error) })
      return null
    }
    if (!provider?.enabled || provider.manifest.contributes.assistantRules === undefined) return null
    const key = `${provider.manifest.id}@${provider.manifest.version}:${provider.manifestDigest}:${provider.rootDir}`
    const distrust = await assistantRulesDistrust(provider, deps.trust ?? ASSISTANT_RULES_TRUST)
    if (distrust) {
      warnOnce(`distrust:${key}`, 'the assistant rules of an App the host does not trust are ignored', { app: key, reason: distrust })
      return null
    }
    if (read?.key !== key) {
      let rules: AssistantProductRules | null = null
      try { rules = await readDeclaredAssistantRules(provider.rootDir, provider.manifest) }
      catch (error) { warnOnce(`invalid:${key}`, 'the assistant App\'s rules are not valid; they are ignored', { app: key, error: messageOf(error) }) }
      read = { key, rules }
      if (rules) {
        kept = { rules, appVersion: provider.manifest.version }
        try { await deps.lastGood.write(kept) }
        catch (error) { warnOnce(`keep:${key}`, 'the assistant rules could not be kept as the last good copy', { app: key, error: messageOf(error) }) }
      }
    }
    return read.rules ? Object.freeze({ source: 'app', rules: read.rules, appVersion: provider.manifest.version }) : null
  }

  async function resolve(): Promise<AssistantRulesAnswer> {
    const app = await fromApp()
    if (app) return app
    const copy = await lastGood()
    return copy ? Object.freeze({ source: 'last-good', rules: copy.rules, appVersion: copy.appVersion }) : NO_ASSISTANT_RULES
  }

  const resolver: AssistantRulesResolver = {
    refresh() {
      if (running?.look === look) return running.answer
      const at = look
      // One at a time: a look begun before the App changed finishes first (it may keep a copy), then this one looks again.
      const before = running?.answer.then(() => undefined, () => undefined) ?? Promise.resolve()
      const answer: Promise<AssistantRulesAnswer> = before.then(resolve).then(next => {
        // The same rules from the same place keep the same snapshot.
        if (!snapshot || snapshot.source !== next.source || snapshot.rules !== next.rules || snapshot.appVersion !== next.appVersion) {
          snapshot = next
          for (const listener of listeners) listener(next)
        }
        snapshotLook = at
        if (next.rules) for (const resolve of waiting.splice(0)) resolve(next)
        return snapshot
      }).finally(() => { if (running?.answer === answer) running = null })
      running = { look: at, answer }
      return answer
    },
    current() {
      return snapshot && snapshotLook === look ? Promise.resolve(snapshot) : resolver.refresh()
    },
    appChanged() {
      look += 1
      return resolver.refresh()
    },
    async available() {
      const answer = await resolver.current()
      return answer.rules ? answer : new Promise<ResolvedAssistantRules>(resolve => { waiting.push(resolve) })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return resolver
}

/** No rules anywhere: the process's resolver until main installs its own. Waiting on it is an error, never a hang. */
const noResolver: AssistantRulesResolver = {
  refresh: () => Promise.resolve(NO_ASSISTANT_RULES),
  current: () => Promise.resolve(NO_ASSISTANT_RULES),
  available: () => Promise.reject(new Error('no assistant rules resolver is installed in this process')),
  subscribe: () => () => {},
  appChanged: () => Promise.resolve(NO_ASSISTANT_RULES),
}
let installed: AssistantRulesResolver | null = null

/** Main installs the process's resolver at start (assistant-rules-root.ts); null takes it out again. */
export function installAssistantRulesResolver(resolver: AssistantRulesResolver | null): void {
  installed = resolver
}

/**
 * A fresh look at the installed App, and the rules once there are any: the one answer when they are there, the wait for
 * them otherwise. For the read points that start something (a session, a setup).
 */
export async function refreshedAssistantRules(): Promise<ResolvedAssistantRules> {
  const answer = await assistantRules().refresh()
  return answer.rules ? answer : assistantRules().available()
}

/** The process's resolver: every read point of the assistant's product rules asks it. */
export function assistantRules(): AssistantRulesResolver {
  return installed ?? noResolver
}
