// #1931 The process's resolver for the personal assistant's product rules: the installed Apps as the extensions service
// records them, and the last good copy in this profile's user data. Kept apart so the resolver stays free of electron.
import * as path from 'node:path'
import { app } from 'electron'
import { createLogger } from './lib/logger'
import { assistantRulesLastGoodStore } from './assistant-rules-last-good'
import { createAssistantRulesResolver, installAssistantRulesResolver } from './assistant-rules-resolver'
import { installedAssistantRulesProvider } from './assistant-rules-trust'
import { extensionsService } from './session/main/core/extensions/extensions-root'

export const ASSISTANT_RULES_DIR_NAME = 'assistant-rules'

/** Called once at start. Nothing is read here: user data is repointed during boot, so every path is resolved when used. */
export function installProcessAssistantRules(): void {
  const log = createLogger('assistant-rules')
  installAssistantRulesResolver(createAssistantRulesResolver({
    provider: () => installedAssistantRulesProvider(extensionsService()),
    lastGood: assistantRulesLastGoodStore(() => path.join(app.getPath('userData'), ASSISTANT_RULES_DIR_NAME)),
    warn: (message, detail) => log.warn(detail, message),
  }))
}
