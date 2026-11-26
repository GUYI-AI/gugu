import type { TFunction } from 'i18next'

const codexDescriptions = new Map([
  ['gpt-6.1-terra', 'gpt61terra'],
  ['gpt-6.1-sol', 'gpt61sol'],
  ['gpt-6-astra', 'gpt6astra'],
  ['gpt-6-sol', 'gpt6sol'],
  ['gpt-6-luna', 'gpt6luna'],
  ['gpt-5.6-sol', 'gpt56sol'],
  ['gpt-5.6-terra', 'gpt56terra'],
  ['gpt-5.6-luna', 'gpt56luna'],
])

/** The shared assembly already named a `default` placeholder after its concrete model (owner 11-25): no 「默认」 here. */
export function phoneModelName(_id: string, name: string, _t: TFunction<'mobileCreateControls'>): string {
  return name
}

export function phoneModelDescription(id: string, name: string, description: string | undefined, t: TFunction<'mobileCreateControls'>): string | undefined {
  // Claude's default row can name the actual model here without supplying prose.
  if (id === 'default' && description && /^(Opus|Fable|Sonnet|Haiku) \d+(?:\.\d+)*$/i.test(description)) return description
  const family = /^(Opus|Fable|Sonnet|Haiku)(?:$| [0-9(])/i.exec(name)?.[1]?.toLowerCase()
  const key = family ?? codexDescriptions.get(name.toLowerCase().replaceAll(' ', '-'))
  return key ? t(`modelDescription.${key}`) : undefined
}
