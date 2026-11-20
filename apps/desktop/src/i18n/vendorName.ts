import { getLocaleSnapshot } from './runtime'

/**
 * Vendor names that the data spells in Chinese: model vendors, provider presets, agent publishers.
 * They are proper nouns and stay out of the catalogs; the English UI shows the vendor's own English name.
 */
const ENGLISH_NAMES: Readonly<Record<string, string>> = {
  '智谱': 'Zhipu',
  '智谱 GLM Coding Plan': 'Zhipu GLM Coding Plan',
  '智谱开放平台': 'Zhipu Open Platform',
}

export function vendorName(name: string): string {
  return getLocaleSnapshot().resolvedLocale === 'zh-CN' ? name : ENGLISH_NAMES[name] ?? name
}
