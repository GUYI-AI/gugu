// A fixture assistant App whose rules folder is generated from a set of rules (by default the neutral test rules: the
// product's own words are the assistant App's and not in this repository), installed into a real extensions service in a
// temporary folder, and a resolver over it.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assistantRulesFiles, type AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { GUGU_APPS_REPO, type MarketCodeSource } from '@shared/extensions/market'
import type { ExtensionOrigin } from '@shared/extensions/upgrade'
import { assistantRulesLastGoodStore } from '../../../../apps/desktop/electron/assistant-rules-last-good'
import { createAssistantRulesResolver, type AssistantRulesResolver, type ResolvedAssistantRules } from '../../../../apps/desktop/electron/assistant-rules-resolver'
import { installedAssistantRulesProvider } from '../../../../apps/desktop/electron/assistant-rules-trust'
import { ExtensionsService } from '../../../../apps/desktop/electron/session/main/core/extensions/extensions-service'
import { NEUTRAL_ASSISTANT_RULES } from './neutralRules'

export const OFFICIAL_SOURCE = (version: string): MarketCodeSource => ({ repo: GUGU_APPS_REPO, path: `releases/gugu-assistant/${version}`, commit: 'a'.repeat(40) })

export interface FixtureApp {
  id?: string
  version?: string
  files?: Record<string, string>
}

/** Writes the App's bundle into `dir` and returns it. */
export async function fixtureBundle(dir: string, app: FixtureApp = {}): Promise<string> {
  await mkdir(join(dir, 'rules'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    id: app.id ?? 'gugu-assistant', name: 'Assistant', version: app.version ?? '0.0.1', apiVersion: 45, defaultLocale: 'en',
    platforms: ['desktop'], entry: 'index.html', contributes: { assistantRules: 'rules' },
  }))
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Assistant</title>')
  for (const [name, content] of Object.entries(app.files ?? assistantRulesFiles(NEUTRAL_ASSISTANT_RULES))) await writeFile(join(dir, 'rules', name), content)
  return dir
}

/** Installs a bundle as the market, a folder, … would: `source` is what a market install records (none: none recorded). */
export function installBundle(service: ExtensionsService, bundle: string, origin: ExtensionOrigin = 'market', source?: MarketCodeSource): void {
  service.installFromDirectory(bundle, service.inspectDirectory(bundle).manifestDigest, origin, undefined, undefined, source)
}

/** The rules with every text, label and default changed, so a render from them differs wherever the rules reach it. */
export function markedRules(marker: string, rulesVersion = '9.9.9'): AssistantProductRules {
  const rules = NEUTRAL_ASSISTANT_RULES
  return {
    format: rules.format,
    rulesVersion,
    defaults: { childHarness: 'codex', defaultModel: `platform:${marker}`, deniedTools: [...rules.defaults.deniedTools, `${marker}Tool`], profileRulesVersion: rules.defaults.profileRulesVersion + 1 },
    labels: Object.fromEntries(Object.entries(rules.labels).map(([key, value]) => [key, `${value} ${marker}`])) as AssistantProductRules['labels'],
    texts: Object.fromEntries(Object.entries(rules.texts).map(([key, value]) => [key, `${value}\n${marker}`])) as AssistantProductRules['texts'],
  }
}

export interface FixtureHost {
  service: ExtensionsService
  resolver: AssistantRulesResolver
  warnings: Array<{ message: string; detail: Record<string, unknown> }>
  /** How many times the resolver looked at the installed App. */
  providerReads(): number
}

/** A resolver that always answers with these rules (as from an App): for tests of what a read point does with them. */
export function fixedAssistantRules(rules: AssistantProductRules = NEUTRAL_ASSISTANT_RULES): AssistantRulesResolver {
  const answer: ResolvedAssistantRules = Object.freeze({ source: 'app', rules, appVersion: '0.0.1' })
  return { refresh: async () => answer, current: async () => answer, available: async () => answer, subscribe: () => () => {} }
}

/** A resolver over a real extensions service rooted in `root`, keeping its last good copy in `lastGoodDir`. */
export function fixtureHost(root: string, lastGoodDir: string): FixtureHost {
  const service = new ExtensionsService(join(root, 'task-extensions'))
  const warnings: FixtureHost['warnings'] = []
  let reads = 0
  const resolver = createAssistantRulesResolver({
    provider: () => { reads++; return installedAssistantRulesProvider(service) },
    lastGood: assistantRulesLastGoodStore(() => lastGoodDir),
    warn: (message, detail) => warnings.push({ message, detail }),
  })
  return { service, resolver, warnings, providerReads: () => reads }
}
