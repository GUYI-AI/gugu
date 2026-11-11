// #1931 The process's resolver for the personal assistant's product rules: the installed Apps as the extensions service
// records them, and the last good copy in this profile's user data. And the step that puts the product's assistant App in
// where the assistant needs it. Kept apart so the resolver and the step stay free of electron.
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { resolveGuguHome } from '@gugu/core/local/state/paths'
import { ASSISTANT_COMPUTER_WORKDIR_NAME } from '@gugu/core/shared/assistantPolicy'
import { createLogger } from './lib/logger'
import { assistantAppEnsurer, type AssistantAppEnsureOutcome, type AssistantAppEnsurer } from './assistant-app-ensure'
import { assistantRulesLastGoodStore } from './assistant-rules-last-good'
import { assistantRules, createAssistantRulesResolver, installAssistantRulesResolver } from './assistant-rules-resolver'
import { ASSISTANT_RULES_PROVIDER_ID, installedAssistantRulesProvider } from './assistant-rules-trust'
import { extensionsService } from './session/main/core/extensions/extensions-root'
import { noteAssistantAppEnsuring } from './session/main/core/extensions/assistant-app-ensuring'

export const ASSISTANT_RULES_DIR_NAME = 'assistant-rules'

const log = createLogger('assistant-rules')

/** Called once at start. Nothing is read here: user data is repointed during boot, so every path is resolved when used. */
export function installProcessAssistantRules(): void {
  installAssistantRulesResolver(createAssistantRulesResolver({
    provider: () => installedAssistantRulesProvider(extensionsService()),
    lastGood: assistantRulesLastGoodStore(() => path.join(app.getPath('userData'), ASSISTANT_RULES_DIR_NAME)),
    warn: (message, detail) => log.warn(detail, message),
  }))
}

/**
 * Whether the assistant lives on this machine: a cloud machine hosts it; elsewhere its home (prepared at setup on this
 * computer or this server) is here.
 */
export function assistantLivesHere(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GUGU_CLOUD_COMPUTER === '1' || existsSync(path.join(resolveGuguHome(env), ASSISTANT_COMPUTER_WORKDIR_NAME))
}

let ensurer: AssistantAppEnsurer | null = null
/** Every attempt of the backoff window failed: from then on the entry is not shown as preparing (it keeps trying, silently). */
let ensureStuck = false

/** Puts the assistant App in where it is needed (assistant-app-ensure.ts): at start, and when the assistant's setup starts. */
export function ensureAssistantApp(reason: 'start' | 'setup'): Promise<AssistantAppEnsureOutcome> {
  ensurer ??= assistantAppEnsurer({
    installed: () => extensionsService().isInstalled(ASSISTANT_RULES_PROVIDER_ID),
    needed: () => assistantLivesHere(),
    install: async () => {
      // The entry on the rail shows「准备中」while this goes on (assistant-app-ensuring.ts).
      if (!ensureStuck) noteAssistantAppEnsuring(true)
      const { installExtensionFromMarket } = await import('./session/main/core/extensions/extension-market-install')
      const outcome = await installExtensionFromMarket({ ref: { extensionId: ASSISTANT_RULES_PROVIDER_ID }, consent: { kind: 'gugu' } })
      if (!outcome.installed) throw new Error(`${ASSISTANT_RULES_PROVIDER_ID} did not go in (${outcome.outcome})`)
    },
    afterInstall: () => assistantRules().refresh(),
    sleep: ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.() }),
    warn: (message, detail) => log.warn(detail, message),
    info: (message, detail) => log.info(detail, message),
    stuck: () => {
      ensureStuck = true
      noteAssistantAppEnsuring(false)
    },
  })
  return ensurer.ensure(reason).finally(() => noteAssistantAppEnsuring(false))
}
