import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { providerPresets } from '@gugu/session-core/models/provider-presets'
import { applyLocalePreference } from '../../../../apps/desktop/src/i18n/runtime'
import { vendorName } from '../../../../apps/desktop/src/i18n/vendorName'
import { MODEL_PROVIDERS } from '../../../../apps/desktop/src/session/renderer/features/sessions/session-config/model-provider'

afterEach(() => applyLocalePreference('system', false))

const CJK = /[㐀-鿿]/u
const AGENTS = path.resolve(__dirname, '../../../../packages/session-plugins/src/agents/impl')

/** Agent publishers and subscription plan names are literals in each agent plugin's source. */
function pluginVendorLiterals(): string[] {
  const found: string[] = []
  for (const agent of readdirSync(AGENTS)) {
    for (const file of ['index.ts', 'subscription.ts']) {
      let source: string
      try { source = readFileSync(path.join(AGENTS, agent, file), 'utf8') } catch { continue }
      for (const match of source.matchAll(/(?:publisher|plan):\s*'([^']+)'|const PLAN_\w+ = '([^']+)'/g)) found.push(match[1] ?? match[2]!)
    }
  }
  return found
}

it('shows a vendor spelled in Chinese under its English name in the English UI only', () => {
  applyLocalePreference('en-US', false)
  expect(vendorName('智谱')).toBe('Zhipu')
  expect(vendorName('火山方舟 Coding Plan')).toBe('Volcengine Ark Coding Plan')
  expect(vendorName('OpenAI')).toBe('OpenAI')
  applyLocalePreference('zh-CN', false)
  expect(vendorName('智谱')).toBe('智谱')
})

it('has an English name for every vendor, preset, publisher and plan the data spells in Chinese', () => {
  const names = [...MODEL_PROVIDERS.map(provider => provider.name), ...providerPresets.map(preset => preset.name), ...pluginVendorLiterals()]
  expect(pluginVendorLiterals()).toContain('腾讯')
  applyLocalePreference('en-US', false)
  expect(names.filter(name => CJK.test(vendorName(name)))).toEqual([])
})
