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
import { assistantAppEnsurer, type AssistantAppEnsureOutcome, type AssistantAppEnsurer } from './assistant-app-ensure'
import { readAssistantProductRules } from './assistant-product-rules'
import { assistantRulesLastGoodStore, type LastGoodAssistantRules } from './assistant-rules-last-good'
import { assistantRules, createAssistantRulesResolver, installAssistantRulesResolver } from './assistant-rules-resolver'
import { ASSISTANT_RULES_PROVIDER_ID, installedAssistantRulesProvider } from './assistant-rules-trust'
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
  const resolver = createAssistantRulesResolver({
    provider: () => installedAssistantRulesProvider(extensionsService()),
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

let ensurer: AssistantAppEnsurer | null = null
/** Whether getting the App in is truly stuck: every try of the backoff window failed, or an App here holds its id unusably. */
let stuck = false

/** Puts the assistant App in where it is needed (assistant-app-ensure.ts): at start, and when the assistant's setup starts. */
export function ensureAssistantApp(reason: 'start' | 'setup'): Promise<AssistantAppEnsureOutcome> {
  ensurer ??= assistantAppEnsurer({
    installed: () => extensionsService().isInstalled(ASSISTANT_RULES_PROVIDER_ID),
    needed: () => assistantLivesHere(),
    install: async () => {
      const { installExtensionFromMarket } = await import('./session/main/core/extensions/extension-market-install')
      const outcome = await installExtensionFromMarket({ ref: { extensionId: ASSISTANT_RULES_PROVIDER_ID }, consent: { kind: 'gugu' } })
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
    // The id is taken by an App gugu does not put over (switched off, a folder, a fork) and no rules came of it.
    if (outcome === 'present' && !(await assistantRules().refresh()).rules) stuck = true
    publishState()
  }, () => {})
  return going
}

const stateListeners = new Set<(state: AssistantRulesState) => void>()
let published: AssistantRulesState = { pending: false, stuck: false }

/** Waiting for rules: this machine needs the assistant (it lives here, or its setup started) and has none of its rules. */
export async function assistantRulesState(): Promise<AssistantRulesState> {
  const answer = await assistantRules().current()
  const pending = !answer.rules && (ensurer?.setupStarted() === true || assistantLivesHere())
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
