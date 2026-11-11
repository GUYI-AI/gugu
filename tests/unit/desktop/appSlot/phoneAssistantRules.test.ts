import { describe, expect, it, vi } from 'vitest'
import { assistantRulesFiles } from '@gugu/core/shared/assistantRulesFormat'
import { GUGU_APPS_REPO, type MarketCodeSource } from '../../../../apps/desktop/src/session/shared/extensions/market'
import { readPhoneAssistantRules, type PhoneMarketData } from '../../../../apps/desktop/src/components/appSlot/phoneAssistantRules'
import { NEUTRAL_ASSISTANT_RULES } from '../assistantRules/neutralRules'
import { markedRules } from '../assistantRules/fixtureApp'

vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

// #1931 The phone's route to the assistant's product rules: the market's assistant App, read (never installed) with the
// same trust and the same validator as the desktop; the last good copy kept in the page's storage for offline.
const OFFICIAL: MarketCodeSource = { repo: GUGU_APPS_REPO, path: 'releases/gugu-assistant/1.0.0', commit: 'a'.repeat(40) }

function packageOf(rules = NEUTRAL_ASSISTANT_RULES, source = OFFICIAL, version = '1.0.0'): Awaited<ReturnType<PhoneMarketData>> {
  const encoder = new TextEncoder()
  const files = new Map<string, Uint8Array>([['manifest.json', encoder.encode('{}')], ['today.html', encoder.encode('<!doctype html>')]])
  for (const [name, content] of Object.entries(assistantRulesFiles(rules))) files.set(`rules/${name}`, encoder.encode(content))
  return { files, source, version, manifest: { id: 'gugu-assistant', version, contributes: { tabs: [], assistantRules: 'rules' } } as never }
}

function storage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) }, items }
}

describe('the phone reads the assistant\'s rules from the market\'s assistant App', () => {
  it('takes gugu\'s own App\'s rules and keeps them for offline', async () => {
    const kept = storage()
    const marketData = vi.fn(async () => packageOf())
    expect(await readPhoneAssistantRules({ marketData, storage: kept })).toEqual(NEUTRAL_ASSISTANT_RULES)
    expect(marketData).toHaveBeenCalledWith('gugu-assistant')
    // Offline later: the kept copy, validated again.
    expect(await readPhoneAssistantRules({ marketData: async () => { throw new Error('offline') }, storage: kept })).toEqual(NEUTRAL_ASSISTANT_RULES)
  })

  it('never takes rules from an App whose code is not in gugu\'s market repository', async () => {
    const kept = storage()
    await readPhoneAssistantRules({ marketData: async () => packageOf(), storage: kept })
    const foreign = packageOf(markedRules('FOREIGN'), { ...OFFICIAL, repo: 'someone/gugu-apps' })
    expect(await readPhoneAssistantRules({ marketData: async () => foreign, storage: kept })).toEqual(NEUTRAL_ASSISTANT_RULES)
    expect(await readPhoneAssistantRules({ marketData: async () => foreign, storage: storage() })).toBeNull()
  })

  it('refuses a rules folder that is not exactly the format, as the desktop does', async () => {
    const broken = packageOf()
    ;(broken.files as Map<string, Uint8Array>).set('rules/recovery.md', new TextEncoder().encode('a\r\nb\n'))
    expect(await readPhoneAssistantRules({ marketData: async () => broken, storage: storage() })).toBeNull()
  })

  it('has none when it never read them and cannot now, or the kept copy no longer validates', async () => {
    expect(await readPhoneAssistantRules({ marketData: async () => { throw new Error('offline') }, storage: storage() })).toBeNull()
    const kept = storage()
    kept.setItem('gugu.assistantRules.lastGood', JSON.stringify({ appVersion: '1.0.0', files: { 'rules.json': '{}' } }))
    expect(await readPhoneAssistantRules({ marketData: async () => { throw new Error('offline') }, storage: kept })).toBeNull()
  })
})
