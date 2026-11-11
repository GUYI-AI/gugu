// #1931 The phone's route to the assistant's product rules. The phone hosts no assistant and installs no assistant App, yet
// two things it shows or sends are the product's words: the first-run introduction, and the owner profile it hands the
// cloud when the person claims a cloud assistant. It reads them from the same App the desktop trusts, as the market
// publishes it: id `gugu-assistant`, its code in gugu's market repository, the bytes checked against the market's record,
// the rules folder validated by the one validator. Read once per page load; the last good copy is kept in the page's
// storage so a phone that read them once still has them offline. Nothing else: no install, nothing run.
import { assistantRulesFiles, type AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { assistantRulesFromPackage, parseAssistantRulesFolder } from '../../session/shared/extensions/assistant-rules-parse'
import { isOfficialMarketSource, type MarketCodeSource } from '../../session/shared/extensions/market'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { rendererLogger } from '../../lib/log'

const log = rendererLogger('assistant-rules')

export const PHONE_ASSISTANT_RULES_APP_ID = 'gugu-assistant'
const LAST_GOOD_KEY = 'gugu.assistantRules.lastGood'

export type PhoneMarketData = (id: string) => Promise<{ files: ReadonlyMap<string, Uint8Array>; manifest: ExtensionManifest; source: MarketCodeSource; version: string }>

export interface PhoneAssistantRulesDeps {
  marketData: PhoneMarketData
  storage: Pick<Storage, 'getItem' | 'setItem'>
}

/** The rules from the market's assistant App, if gugu's own: throws what is wrong. */
async function fromMarket(marketData: PhoneMarketData): Promise<{ rules: AssistantProductRules; appVersion: string }> {
  const app = await marketData(PHONE_ASSISTANT_RULES_APP_ID)
  if (!isOfficialMarketSource(app.source)) throw new Error(`${PHONE_ASSISTANT_RULES_APP_ID} is not gugu's own App (its code is at ${app.source.repo})`)
  const folder = app.manifest.contributes.assistantRules
  if (folder === undefined) throw new Error(`${PHONE_ASSISTANT_RULES_APP_ID}@${app.version} declares no assistant rules`)
  return { rules: assistantRulesFromPackage(app.files, folder), appVersion: app.version }
}

function readKept(storage: PhoneAssistantRulesDeps['storage']): AssistantProductRules | null {
  const text = storage.getItem(LAST_GOOD_KEY)
  if (!text) return null
  const kept = JSON.parse(text) as { files: Record<string, string> }
  const encoder = new TextEncoder()
  return parseAssistantRulesFolder(new Map(Object.entries(kept.files).map(([name, content]) => [name, encoder.encode(content)])))
}

/** The rules the phone uses: the market's trusted App's, else the copy kept from the last time; null with neither. */
export async function readPhoneAssistantRules(deps: PhoneAssistantRulesDeps): Promise<AssistantProductRules | null> {
  try {
    const { rules, appVersion } = await fromMarket(deps.marketData)
    try { deps.storage.setItem(LAST_GOOD_KEY, JSON.stringify({ appVersion, files: assistantRulesFiles(rules) })) }
    catch (error) { log.warn({ error: error instanceof Error ? error.message : String(error) }, 'assistant rules not kept on this phone') }
    return rules
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, 'assistant rules not read from the market; the kept copy is used')
  }
  try { return readKept(deps.storage) }
  catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, 'the kept assistant rules on this phone are not valid')
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
