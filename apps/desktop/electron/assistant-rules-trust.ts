// #1931 Whom the host believes about the personal assistant's product rules: the product's own assistant App, installed
// from the official market source as the release signed with a key this build trusts, its rules still the signed bytes.
// Each condition names why an installed App is not believed; nothing that asks changes.
import type { ExtensionManifest } from '@shared/extensions/manifest'
import type { MarketInstallRecord } from '@shared/extensions/market'
import { ASSISTANT_APP_ID, ASSISTANT_APP_TRUST } from '@shared/extensions/assistant-entry'
import type { ExtensionOrigin } from '@shared/extensions/upgrade'
import { assistantAppHere, type AssistantAppHere } from './assistant-app-ensure'
import type { InstalledExtension } from './session/main/core/extensions/extensions-service'
import { firstProblem, releaseFileProblems, SHIPPED_RELEASE_TRUST, verifyReleaseProof, type ReleaseTrustTable } from './session/main/core/extensions/release/market-release'

/** The product's assistant App (GUYI-AI/gugu-assistant), published to the market as a compiled release. */
export const ASSISTANT_RULES_PROVIDER_ID = ASSISTANT_APP_ID

/** What the host knows of the installed App that may provide the rules. */
export interface AssistantRulesProvider {
  manifest: Pick<ExtensionManifest, 'id' | 'version' | 'contributes'>
  rootDir: string
  manifestDigest: string
  origin: ExtensionOrigin | undefined
  /** Where in the market its code was, and its verified release proof, as recorded when it was installed from there. */
  marketSource: MarketInstallRecord | null
  /** The variant in use: `upstream` unless a fork of it is switched on. */
  activeVariant: string
  enabled: boolean
}

/** One reason not to believe a provider, or null. It may look at the bundle (a signature), so it may be async. */
export type AssistantRulesTrustCondition = (provider: AssistantRulesProvider) => string | null | Promise<string | null>

/**
 * The conditions, with the release keys of `table` (the shipped one; tests pass their own). The first ones are the shared
 * list (assistant-entry.ts `ASSISTANT_APP_TRUST`: its id, from the market, gugu's repository, not a fork, its signed release
 * folder), which the assistant's place on both hosts also reads; the last is the signed release itself (market-release.ts):
 * its proof verifying again, and the manifest and rules folder on disk still being the signed bytes — edited there, the App
 * is not believed and the last good copy stays in use.
 */
export function assistantRulesTrust(table: ReleaseTrustTable = SHIPPED_RELEASE_TRUST): readonly AssistantRulesTrustCondition[] {
  return Object.freeze([...ASSISTANT_APP_TRUST, (provider: AssistantRulesProvider) => signedReleaseDistrust(provider, table)])
}

function signedReleaseDistrust(provider: AssistantRulesProvider, table: ReleaseTrustTable): string | null {
  const proof = provider.marketSource?.release
  if (!proof) return 'no signed release was recorded when it was installed'
  let release
  try { release = verifyReleaseProof(proof, { appId: provider.manifest.id, version: provider.manifest.version }, table) }
  catch (error) { return error instanceof Error ? error.message : String(error) }
  const folder = provider.manifest.contributes.assistantRules
  const problems = releaseFileProblems(provider.rootDir, release, ['manifest.json', ...(folder === undefined ? [] : [`${folder}/`])])
  return problems.length ? `its files are not the signed ones (${firstProblem(problems)})` : null
}

export const ASSISTANT_RULES_TRUST: readonly AssistantRulesTrustCondition[] = assistantRulesTrust()

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
  marketSource(extensionId: string): MarketInstallRecord | null
  variants(extensionId: string): { active: string }
  isEnabled(extensionId: string): boolean
}

/**
 * The installed assistant App to the ensure step (assistant-app-ensure.ts `assistantAppHere`): none, the person's own copy,
 * or gugu's market copy — believed by these conditions or not. One whose record cannot be read is left as it is: gugu does
 * not put over what it cannot read.
 */
export async function installedAssistantAppHere(
  service: AssistantRulesInstallRecord, conditions: readonly AssistantRulesTrustCondition[] = ASSISTANT_RULES_TRUST,
): Promise<AssistantAppHere> {
  let provider: AssistantRulesProvider | null
  try { provider = installedAssistantRulesProvider(service) }
  catch (error) { return { state: 'own', reason: `it could not be read (${error instanceof Error ? error.message : String(error)})` } }
  const found = provider
  if (!found) return { state: 'absent' }
  const { origin, activeVariant, enabled, manifestDigest, manifest: { version } } = found
  return assistantAppHere({ origin, activeVariant, enabled, version, manifestDigest }, () => assistantRulesDistrust(found, conditions))
}

/**
 * The resolver told each time the assistant App changes here — installed, updated, a fork switched, switched on or off,
 * removed: the service says so once each is written, whoever did it (the Apps page, an update, the ensure step, an agent) —
 * so trust is decided again then, not only at the next start. Main hears it from its first look at the App on (the service
 * is made lazily: user data is repointed during boot); a change before that look is seen by the look itself.
 */
export function hearAssistantAppChanges(
  service: { onBindingAuthorityChanged(listener: (extensionId: string) => void): () => void },
  resolver: { appChanged(): Promise<unknown> },
): () => void {
  return service.onBindingAuthorityChanged((extensionId) => {
    if (extensionId === ASSISTANT_RULES_PROVIDER_ID) void resolver.appChanged()
  })
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
