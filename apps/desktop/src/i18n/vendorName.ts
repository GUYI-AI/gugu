import { getLocaleSnapshot } from './runtime'

/**
 * Vendor names that the data spells in Chinese: model vendors, provider presets, agent publishers and the plan
 * names a vendor's subscription reading reports. They are proper nouns and stay out of the catalogs; the English UI
 * shows the vendor's own English name. This table is the only place they are translated: a surface that shows one
 * of these names passes it through `vendorName`.
 */
const ENGLISH_NAMES: Readonly<Record<string, string>> = {
  // model vendors (session-config/model-provider.ts) and agent publishers (session-plugins agents/impl/*)
  '智谱': 'Zhipu',
  '腾讯': 'Tencent',
  '亚马逊': 'Amazon',
  '通义千问': 'Qwen',
  '小米': 'Xiaomi',
  '开源': 'Open source',
  // provider presets (session-core models/provider-presets.ts)
  '智谱 GLM Coding Plan': 'Zhipu GLM Coding Plan',
  '智谱开放平台': 'Zhipu Open Platform',
  '火山方舟 Coding Plan': 'Volcengine Ark Coding Plan',
  'Kimi 开放平台': 'Kimi Open Platform',
  '硅基流动': 'SiliconFlow',
  // subscription plans (session-plugins agents/impl/{qwen,mimocode}/subscription.ts)
  '百炼 Coding Plan': 'Model Studio Coding Plan',
  '百炼 Token Plan': 'Model Studio Token Plan',
  '阿里云百炼按量': 'Alibaba Cloud Model Studio, pay-as-you-go',
  'MiMo 按量付费': 'MiMo pay-as-you-go',
  'MiMo Token Plan 团队版': 'MiMo Token Plan for Teams',
}

export function vendorName(name: string): string {
  return getLocaleSnapshot().resolvedLocale === 'zh-CN' ? name : ENGLISH_NAMES[name] ?? name
}
