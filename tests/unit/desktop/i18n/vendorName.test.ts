import { afterEach, expect, it } from 'vitest'
import { applyLocalePreference } from '../../../../apps/desktop/src/i18n/runtime'
import { vendorName } from '../../../../apps/desktop/src/i18n/vendorName'

afterEach(() => applyLocalePreference('system', false))

it('shows a vendor spelled in Chinese under its English name in the English UI only', () => {
  applyLocalePreference('en-US', false)
  expect(vendorName('智谱')).toBe('Zhipu')
  expect(vendorName('智谱开放平台')).toBe('Zhipu Open Platform')
  expect(vendorName('OpenAI')).toBe('OpenAI')
  applyLocalePreference('zh-CN', false)
  expect(vendorName('智谱')).toBe('智谱')
})
