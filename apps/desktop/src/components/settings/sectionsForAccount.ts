import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels'
import type { AuthUser } from '@/store/auth'
import { hasTeamAccountMarker } from '@/features/team/accountKind'

/** Team replaces Subscriptions; a caller's broad section allowlist never exposes both identities' destinations. */
export function settingsSectionsForAccount(sections: readonly ActiveSection[], user: AuthUser | null): ActiveSection[] {
  const team = hasTeamAccountMarker(user)
  return sections.filter(section => team ? section !== 'subscriptions' : section !== 'team')
}
