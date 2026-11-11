// #1931 Which personal-assistant product rules the host uses: the trusted assistant App's, else the last good copy the
// host kept of them, else the built-in copy. `source` says which, so "none of them" is detectable once the built-in copy
// is removed.
//
// Cheap to read: an App version's folder is read and validated once (keyed by version, manifest digest and folder), not
// per turn. `refresh` looks at the installed App again — at each assistant session start and at setup — and `current`
// answers from memory once anything was resolved in this process. Each answer is one frozen snapshot that the next
// refresh replaces whole: a render that took it keeps it to the end, so a new version takes effect between renders,
// never inside one.
import { BUILT_IN_ASSISTANT_RULES } from '@gugu/core/shared/assistantProductRules/builtIn'
import type { AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { readDeclaredAssistantRules } from './assistant-product-rules'
import type { AssistantRulesLastGoodStore, LastGoodAssistantRules } from './assistant-rules-last-good'
import { assistantRulesDistrust, ASSISTANT_RULES_TRUST, type AssistantRulesProvider, type AssistantRulesTrustCondition } from './assistant-rules-trust'

export type AssistantRulesSource = 'app' | 'last-good' | 'built-in'

export interface ResolvedAssistantRules {
  readonly source: AssistantRulesSource
  readonly rules: AssistantProductRules
  /** The assistant App version the rules came from; null for the built-in copy. */
  readonly appVersion: string | null
}

export interface AssistantRulesResolverDeps {
  /** The installed App that may provide the rules, or null. Read at each refresh only. */
  provider(): AssistantRulesProvider | null | Promise<AssistantRulesProvider | null>
  lastGood: AssistantRulesLastGoodStore
  trust?: readonly AssistantRulesTrustCondition[]
  /** Said once for each thing that went wrong (an App version, the kept copy): the next refresh does not repeat it. */
  warn(message: string, detail: Record<string, unknown>): void
}

export interface AssistantRulesResolver {
  /** Looks at the installed App again and answers with the rules to use from now on. One at a time: a call while one runs gets that one. */
  refresh(): Promise<ResolvedAssistantRules>
  /** The rules in use: from memory once anything was resolved in this process; the first call resolves. */
  current(): Promise<ResolvedAssistantRules>
}

const BUILT_IN: ResolvedAssistantRules = Object.freeze({ source: 'built-in', rules: BUILT_IN_ASSISTANT_RULES, appVersion: null })

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createAssistantRulesResolver(deps: AssistantRulesResolverDeps): AssistantRulesResolver {
  let snapshot: ResolvedAssistantRules | null = null
  let running: Promise<ResolvedAssistantRules> | null = null
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

  async function resolve(): Promise<ResolvedAssistantRules> {
    const app = await fromApp()
    if (app) return app
    const copy = await lastGood()
    return copy ? Object.freeze({ source: 'last-good', rules: copy.rules, appVersion: copy.appVersion }) : BUILT_IN
  }

  const resolver: AssistantRulesResolver = {
    refresh() {
      running ??= resolve().then(next => {
        // The same rules from the same place keep the same snapshot.
        if (!snapshot || snapshot.source !== next.source || snapshot.rules !== next.rules || snapshot.appVersion !== next.appVersion) snapshot = next
        return snapshot
      }).finally(() => { running = null })
      return running
    },
    current() {
      return snapshot ? Promise.resolve(snapshot) : resolver.refresh()
    },
  }
  return resolver
}

/** Answers with the built-in copy only: the process's resolver until main installs its own (and in tests that install none). */
const builtInOnly: AssistantRulesResolver = { refresh: () => Promise.resolve(BUILT_IN), current: () => Promise.resolve(BUILT_IN) }
let installed: AssistantRulesResolver | null = null

/** Main installs the process's resolver at start (assistant-rules-root.ts); null puts back the built-in-only one. */
export function installAssistantRulesResolver(resolver: AssistantRulesResolver | null): void {
  installed = resolver
}

/** The process's resolver: every read point of the assistant's product rules asks it. */
export function assistantRules(): AssistantRulesResolver {
  return installed ?? builtInOnly
}
