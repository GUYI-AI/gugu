// #1931 Whom the host believes about the personal assistant's product rules: the product's own assistant App, installed
// from the official market source. Each condition names why an installed App is not believed. A release signature check
// is one more entry in ASSISTANT_RULES_TRUST; nothing that asks changes.
import type { ExtensionManifest } from '@shared/extensions/manifest'
import { isOfficialMarketSource, type MarketCodeSource } from '@shared/extensions/market'
import type { ExtensionOrigin } from '@shared/extensions/upgrade'
import type { InstalledExtension } from './session/main/core/extensions/extensions-service'

/** The product's assistant App (GUYI-AI/gugu-assistant), published to the market as a compiled release. */
export const ASSISTANT_RULES_PROVIDER_ID = 'gugu-assistant'

/** What the host knows of the installed App that may provide the rules. */
export interface AssistantRulesProvider {
  manifest: Pick<ExtensionManifest, 'id' | 'version' | 'contributes'>
  rootDir: string
  manifestDigest: string
  origin: ExtensionOrigin | undefined
  /** Where in the market its code was, as recorded when it was installed from there. */
  marketSource: MarketCodeSource | null
  /** The variant in use: `upstream` unless a fork of it is switched on. */
  activeVariant: string
  enabled: boolean
}

/** One reason not to believe a provider, or null. It may look at the bundle (a signature), so it may be async. */
export type AssistantRulesTrustCondition = (provider: AssistantRulesProvider) => string | null | Promise<string | null>

export const ASSISTANT_RULES_TRUST: readonly AssistantRulesTrustCondition[] = Object.freeze([
  provider => provider.manifest.id === ASSISTANT_RULES_PROVIDER_ID ? null : `it is ${provider.manifest.id}, not ${ASSISTANT_RULES_PROVIDER_ID}`,
  provider => provider.origin === 'market' ? null : `it was installed from ${provider.origin ?? 'an unrecorded place'}, not the market`,
  provider => !provider.marketSource ? 'there is no record of where in the market its code was'
    : isOfficialMarketSource(provider.marketSource) ? null : `its code is at ${provider.marketSource.repo}, not in gugu's market repository`,
  provider => provider.activeVariant === 'upstream' ? null : `its fork "${provider.activeVariant}" is in use`,
])

/** Why the provider is not believed — the first condition that fails — or null when every one holds. */
export async function assistantRulesDistrust(
  provider: AssistantRulesProvider, conditions: readonly AssistantRulesTrustCondition[] = ASSISTANT_RULES_TRUST,
): Promise<string | null> {
  for (const condition of conditions) {
    const reason = await condition(provider)
    if (reason) return reason
  }
  return null
}

/** The parts of the extensions service the provider is read from. */
export interface AssistantRulesInstallRecord {
  isInstalled(extensionId: string): boolean
  get(extensionId: string): InstalledExtension
  origins(): Record<string, ExtensionOrigin>
  marketSource(extensionId: string): MarketCodeSource | null
  variants(extensionId: string): { active: string }
  isEnabled(extensionId: string): boolean
}

/** The installed assistant App as the trust check sees it; null when none is installed. Throws what reading the record throws. */
export function installedAssistantRulesProvider(service: AssistantRulesInstallRecord): AssistantRulesProvider | null {
  if (!service.isInstalled(ASSISTANT_RULES_PROVIDER_ID)) return null
  const installed = service.get(ASSISTANT_RULES_PROVIDER_ID)
  return {
    manifest: installed.manifest,
    rootDir: installed.rootDir,
    manifestDigest: installed.manifestDigest,
    origin: service.origins()[ASSISTANT_RULES_PROVIDER_ID],
    marketSource: service.marketSource(ASSISTANT_RULES_PROVIDER_ID),
    activeVariant: service.variants(ASSISTANT_RULES_PROVIDER_ID).active,
    enabled: service.isEnabled(ASSISTANT_RULES_PROVIDER_ID),
  }
}
