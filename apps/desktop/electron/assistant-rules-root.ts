// #1931 The process's resolver for the personal assistant's product rules: the installed Apps as the extensions service
// records them, the last good copy in this profile's user data, and the copy packaged with this release to start that from.
// The step that puts the product's assistant App in where the assistant needs it. And what the windows are told about it:
// whether the assistant here is waiting for its rules (its entry shows it preparing), and whether that is truly stuck.
// Kept apart so the resolver and the step stay free of electron.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { resolveGuguHome } from '@gugu/core/local/state/paths'
import { ASSISTANT_COMPUTER_WORKDIR_NAME } from '@gugu/core/shared/assistantPolicy'
import type { AssistantRulesState } from '../src/lib/assistantHomeIpc'
import { createLogger } from './lib/logger'
import { assistantAppEnsurer, type AssistantAppEnsureOutcome, type AssistantAppEnsureReason, type AssistantAppEnsurer } from './assistant-app-ensure'
import { readAssistantProductRules } from './assistant-product-rules'
import { assistantRulesLastGoodStore, type LastGoodAssistantRules } from './assistant-rules-last-good'
import { assistantRules, createAssistantRulesResolver, installAssistantRulesResolver } from './assistant-rules-resolver'
import { ASSISTANT_RULES_PROVIDER_ID, hearAssistantAppChanges, installedAssistantAppHere, installedAssistantRulesProvider } from './assistant-rules-trust'
import { extensionsService } from './session/main/core/extensions/extensions-root'

export const ASSISTANT_RULES_DIR_NAME = 'assistant-rules'
/** Where a release carries the assistant App's rules (scripts/build/assistant-rules-seed.ts writes it at build time). */
export const ASSISTANT_RULES_SEED_DIR_NAME = 'assistant-rules-seed'

const log = createLogger('assistant-rules')

const seedRecord = z.strictObject({ app: z.literal(ASSISTANT_RULES_PROVIDER_ID), version: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })

/**
 * The copy of the assistant App's rules this release was built with (`seed.json` + `rules/`), read through the same
 * validator; null when the release carries none. Only ever used to start the last good copy: an installed App wins.
 */
export async function readAssistantRulesSeed(dir: string): Promise<LastGoodAssistantRules | null> {
  let text: string
  try { text = await readFile(path.join(dir, 'seed.json'), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const record = seedRecord.parse(JSON.parse(text))
  return { rules: await readAssistantProductRules(dir, 'rules'), appVersion: record.version }
}

function seedDir(): string {
  return process.env.GUGU_ASSISTANT_RULES_SEED_DIR
    ?? (app.isPackaged ? path.join(process.resourcesPath, ASSISTANT_RULES_SEED_DIR_NAME) : path.join(app.getAppPath(), ASSISTANT_RULES_SEED_DIR_NAME))
}

/** Called once at start. Nothing is read here: user data is repointed during boot, so every path is resolved when used. */
export function installProcessAssistantRules(): void {
  let hearing: (() => void) | null = null
  const resolver = createAssistantRulesResolver({
    provider: () => {
      const service = extensionsService()
      hearing ??= hearAssistantAppChanges(service, resolver)
      return installedAssistantRulesProvider(service)
    },
    lastGood: assistantRulesLastGoodStore(() => path.join(app.getPath('userData'), ASSISTANT_RULES_DIR_NAME)),
    seed: () => readAssistantRulesSeed(seedDir()),
    warn: (message, detail) => log.warn(detail, message),
  })
  installAssistantRulesResolver(resolver)
  resolver.subscribe(() => publishState())
}

/**
 * Whether the assistant lives on this machine: a cloud machine hosts it; elsewhere its home (prepared at setup on this
 * computer or this server) is here.
 */
export function assistantLivesHere(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GUGU_CLOUD_COMPUTER === '1' || existsSync(path.join(resolveGuguHome(env), ASSISTANT_COMPUTER_WORKDIR_NAME))
}

/**
 * Whether the signed-in account has an assistant of its own, wherever it lives (its provision marker, read in main): the App
 * is that assistant's page here. Unreadable or no one signed in: no (the window's next sync asks again).
 */
async function accountHasAssistant(): Promise<boolean> {
  try {
    const { signedInAccountAssistant } = await import('./session/main/core/extensions/app-assistant-binding')
    const { ownerId, assistantId } = await signedInAccountAssistant()
    accountAssistant = { ownerId, has: assistantId !== null }
    // Told now, not after the install: the entry shows it preparing while the App goes in.
    publishState()
    return assistantId !== null
  } catch (error) {
    log.info({ error: String(error) }, 'assistant App: whether this account has an assistant is not known now')
    return false
  }
}
/** The last answer of `accountHasAssistant`, for the account it was about. */
let accountAssistant: { ownerId: string; has: boolean } | null = null
/** Whether the last answer says the account signed in now has an assistant (the account is read again: a switch is not it). */
async function knownAccountAssistant(): Promise<boolean> {
  if (!accountAssistant?.has) return false
  try {
    const { account } = await import('./session/main/core/extensions/app-unread-bindings')
    return (await account()).ownerId === accountAssistant.ownerId
  } catch {
    return false
  }
}

/** Whether this machine needs the App now: as the rules of an assistant living here, or as the page of the account's assistant. */
async function appNeededHere(): Promise<boolean> {
  return assistantLivesHere() || accountHasAssistant()
}

let ensurer: AssistantAppEnsurer | null = null
/** Whether getting the App in is truly stuck: every try of the backoff window failed, or an App here holds its id unusably. */
let stuck = false

/**
 * Puts the assistant App in where it is needed (assistant-app-ensure.ts): at start, when the assistant's setup starts, and
 * when a window found the account's assistant while no trusted App is in (assistant-app-entry.ts).
 */
export function ensureAssistantApp(reason: AssistantAppEnsureReason): Promise<AssistantAppEnsureOutcome> {
  ensurer ??= assistantAppEnsurer({
    installed: () => installedAssistantAppHere(extensionsService()),
    needed: appNeededHere,
    install: async (over) => {
      const { installExtensionFromMarket } = await import('./session/main/core/extensions/extension-market-install')
      const outcome = await installExtensionFromMarket({ ref: { extensionId: ASSISTANT_RULES_PROVIDER_ID }, consent: { kind: 'gugu', ...(over ? { over } : {}) } })
      if (!outcome.installed) throw new Error(`${ASSISTANT_RULES_PROVIDER_ID} did not go in (${outcome.outcome})`)
    },
    afterInstall: () => assistantRules().refresh(),
    sleep: ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.() }),
    warn: (message, detail) => log.warn(detail, message),
    info: (message, detail) => log.info(detail, message),
    stuck: (error) => {
      log.error({ error }, 'assistant App: still not in after the whole backoff window')
      stuck = true
      publishState()
    },
  })
  const going = ensurer.ensure(reason)
  publishState()
  void going.then(async (outcome) => {
    // Rules here: nothing is stuck. None, while an App holds the id that brings none and that this step will not put over
    // (the person's own copy, or gugu's that is still not trusted): truly stuck. With the kept copy nothing is said.
    if (outcome !== 'not-needed') stuck = !(await assistantRules().refresh()).rules
    publishState()
  }, () => {})
  return going
}

const stateListeners = new Set<(state: AssistantRulesState) => void>()
let published: AssistantRulesState = { pending: false, stuck: false }

/** Waiting for rules: this machine needs the assistant (it lives here, or its setup started) and has none of its rules. */
export async function assistantRulesState(): Promise<AssistantRulesState> {
  const answer = await assistantRules().current()
  // Waiting = no App to give rules or the page, where one is needed: the assistant lives here, its setup started, or the
  // account signed in has one elsewhere (the App is its page here).
  const pending = !answer.rules && (ensurer?.setupStarted() === true || assistantLivesHere() || await knownAccountAssistant())
  return { pending, stuck: pending && stuck }
}

function publishState(): void {
  void assistantRulesState().then((next) => {
    if (next.pending === published.pending && next.stuck === published.stuck) return
    published = next
    for (const listener of stateListeners) listener(next)
  }, (error: unknown) => log.warn({ error: String(error) }, 'assistant rules state not read'))
}

/** Told each time the state changes; the IPC layer forwards it to every window. */
export function onAssistantRulesState(listener: (state: AssistantRulesState) => void): () => void {
  stateListeners.add(listener)
  return () => { stateListeners.delete(listener) }
}
