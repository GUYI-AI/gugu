import type { TFunction } from 'i18next'

export function phoneModelName(id: string, name: string, t: TFunction<'mobileCreateControls'>): string {
  return id === 'default' || name === 'Default (recommended)' ? t('modelRecommended') : name
}

export function phoneModelDescription(id: string, name: string, description: string | undefined, t: TFunction<'mobileCreateControls'>): string | undefined {
  // Claude's default row can name the actual model here without supplying prose.
  if (id === 'default' && description && /^(Opus|Fable|Sonnet|Haiku) \d+(?:\.\d+)*$/i.test(description)) return description
  const family = /^(Opus|Fable|Sonnet|Haiku)(?:$| [0-9(])/i.exec(name)?.[1]?.toLowerCase()
  return family ? t(`modelDescription.${family}`) : undefined
}
