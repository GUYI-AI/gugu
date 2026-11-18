// #1931 The phone's route to the assistant's product rules. The phone hosts no assistant and installs no assistant App, yet
// two things it shows or sends are the product's words: the first-run introduction, and the owner profile it hands the
// cloud when the person claims a cloud assistant. It reads them from the same App the desktop trusts, as the market
// publishes it, and believes them on the same terms as the desktop (assistant-rules-trust.ts):
// - id `gugu-assistant`, its code in gugu's market repository, in its release folder;
// - its signed release verified with the keys this build ships (the market's own contract, release-trust.ts): signature,
//   key scope and revocation, this App and version, the package the index names (phoneMarket.ts, before it is fetched);
// - the files it reads — the manifest and the rules folder — exactly the signed bytes;
// - then the rules folder validated by the one validator.
// Read once per page load. The last good copy is kept in the page's storage with its signed release, and checked again the
// same way whenever it is read, so a phone that read them once still has them offline. Anything that fails leaves the
// last good copy as it was; nothing is taken in part. Nothing else: no install, nothing run.
import type { AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { assistantRulesFromPackage } from '../../session/shared/extensions/assistant-rules-parse'
import { isOfficialMarketSource, type MarketCodeSource, type MarketReleaseProof } from '../../session/shared/extensions/market'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import {
  base64Of, bytesOfBase64, firstProblem, sha256Hex, SHIPPED_RELEASE_TRUST, signedFileProblems, verifyReleaseProof, withinScope,
  type FileDigest, type ReleaseTrustTable, type SignedRelease,
} from '../../session/shared/extensions/release/release-trust-web'
import { rendererLogger } from '../../lib/log'

const log = rendererLogger('assistant-rules')

export const PHONE_ASSISTANT_RULES_APP_ID = 'gugu-assistant'
export const PHONE_ASSISTANT_RULES_KEPT_KEY = 'gugu.assistantRules.lastGood'

export type PhoneMarketData = (id: string) => Promise<{
  files: ReadonlyMap<string, Uint8Array>
  manifest: ExtensionManifest
  source: MarketCodeSource
  version: string
  /** Its signed release as the market check verified it (phoneMarket.ts); absent for an App the trust table does not name. */
  release?: { release: SignedRelease; proof: MarketReleaseProof }
}>

export interface PhoneAssistantRulesDeps {
  marketData: PhoneMarketData
  storage: Pick<Storage, 'getItem' | 'setItem'>
  /** The release keys believed: the ones this build ships (tests pass their own). */
  trust?: ReleaseTrustTable
}

/** The kept copy: the files the rules were read from, byte for byte, and the signed release they were checked against. */
interface KeptRules {
  appVersion: string
  folder: string
  release: MarketReleaseProof
  files: Record<string, string>
}

/** The files the phone reads: the manifest (it names the folder) and the rules folder. */
const readScope = (folder: string) => ['manifest.json', `${folder.replace(/\/+$/, '')}/`]

/** The files read, against the signed release: every one signed and unchanged, none missing. Throws what differs. */
async function requireSignedFiles(files: ReadonlyMap<string, Uint8Array>, release: SignedRelease, folder: string): Promise<void> {
  const scope = readScope(folder)
  const found = new Map<string, FileDigest>()
  for (const [path, bytes] of files) if (withinScope(path, scope)) found.set(path, { sha256: await sha256Hex(bytes), bytes: bytes.byteLength })
  const problems = signedFileProblems(found, release, scope)
  if (problems.length) throw new Error(`its files are not the signed ones (${firstProblem(problems)})`)
}

/** The rules from the market's assistant App, if it is gugu's own signed release: throws what is wrong. */
async function fromMarket(marketData: PhoneMarketData, trust: ReleaseTrustTable): Promise<{ rules: AssistantProductRules; kept: KeptRules }> {
  const app = await marketData(PHONE_ASSISTANT_RULES_APP_ID)
  const at = `${PHONE_ASSISTANT_RULES_APP_ID}@${app.version}`
  if (!isOfficialMarketSource(app.source)) throw new Error(`${PHONE_ASSISTANT_RULES_APP_ID} is not gugu's own App (its code is at ${app.source.repo})`)
  const releaseFolder = `releases/${PHONE_ASSISTANT_RULES_APP_ID}/${app.version}`
  if (app.source.path !== releaseFolder) throw new Error(`${at}: its code is at ${app.source.path}, not in its signed release folder ${releaseFolder}`)
  const folder = app.manifest.contributes.assistantRules
  if (folder === undefined) throw new Error(`${at} declares no assistant rules`)
  if (!app.release) throw new Error(`${at} came without the signed release gugu requires for it`)
  // Verified again here with the keys this read believes: what is kept must verify the same way when it is read back.
  const release = verifyReleaseProof(app.release.proof, { appId: PHONE_ASSISTANT_RULES_APP_ID, version: app.version }, trust)
  await requireSignedFiles(app.files, release, folder)
  const rules = assistantRulesFromPackage(app.files, folder)
  const scope = readScope(folder)
  const files = Object.fromEntries([...app.files].filter(([path]) => withinScope(path, scope)).map(([path, bytes]) => [path, base64Of(bytes)]))
  return { rules, kept: { appVersion: app.version, folder, release: app.release.proof, files } }
}

/** The kept copy, checked as the market's was: its signed release verifies with the keys believed, its files are the signed bytes. */
async function readKept(storage: PhoneAssistantRulesDeps['storage'], trust: ReleaseTrustTable): Promise<AssistantProductRules | null> {
  const text = storage.getItem(PHONE_ASSISTANT_RULES_KEPT_KEY)
  if (!text) return null
  const kept = JSON.parse(text) as Partial<KeptRules>
  if (!kept.release || typeof kept.appVersion !== 'string' || typeof kept.folder !== 'string' || !kept.files || typeof kept.files !== 'object') {
    throw new Error('the kept copy has no signed release')
  }
  const release = verifyReleaseProof(kept.release, { appId: PHONE_ASSISTANT_RULES_APP_ID, version: kept.appVersion }, trust)
  const files = new Map(Object.entries(kept.files).map(([path, data]) => [path, bytesOfBase64(String(data))]))
  await requireSignedFiles(files, release, kept.folder)
  // The folder read is the one the signed manifest names.
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))) as { contributes?: { assistantRules?: unknown } }
  if (manifest.contributes?.assistantRules !== kept.folder) throw new Error(`the kept copy reads ${kept.folder}, not the folder its manifest names`)
  return assistantRulesFromPackage(files, kept.folder)
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The rules the phone uses: the market's signed assistant App's, else the copy kept from the last time; null with neither. */
export async function readPhoneAssistantRules(deps: PhoneAssistantRulesDeps): Promise<AssistantProductRules | null> {
  const trust = deps.trust ?? SHIPPED_RELEASE_TRUST
  try {
    const { rules, kept } = await fromMarket(deps.marketData, trust)
    try { deps.storage.setItem(PHONE_ASSISTANT_RULES_KEPT_KEY, JSON.stringify(kept)) }
    catch (error) { log.warn({ error: messageOf(error) }, 'assistant rules not kept on this phone') }
    return rules
  } catch (error) {
    log.warn({ error: messageOf(error) }, 'assistant rules not read from the market; the kept copy is used')
  }
  try { return await readKept(deps.storage, trust) }
  catch (error) {
    log.warn({ error: messageOf(error) }, 'the kept assistant rules on this phone are not valid')
    return null
  }
}

let once: Promise<AssistantProductRules | null> | null = null

/** This page's answer, read once (a failed read is asked again next time). */
export function phoneAssistantRules(): Promise<AssistantProductRules | null> {
  once ??= import('./phoneApps').then(({ phoneApps }) => readPhoneAssistantRules({ marketData: phoneApps.marketData, storage: localStorage }))
    .then((rules) => { if (!rules) once = null; return rules }, (error: unknown) => { once = null; throw error })
  return once
}
