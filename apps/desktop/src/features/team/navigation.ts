import { useEffect } from 'react'

export type TeamSection = 'overview' | 'directory' | 'usage' | 'search' | 'members' | 'credits'
export const TEAM_NAVIGATION_EVENT = 'gugu:open-team'
export function isTeamSection(value: unknown): value is TeamSection {
  return typeof value === 'string' && ['overview', 'directory', 'usage', 'search', 'members', 'credits'].includes(value)
}
export function openTeamPage(section: TeamSection = 'overview') {
  window.dispatchEvent(new CustomEvent(TEAM_NAVIGATION_EVENT, { detail: { section } }))
}
export function useTeamNavigation(onOpen: () => void) {
  useEffect(() => {
    window.addEventListener(TEAM_NAVIGATION_EVENT, onOpen)
    return () => window.removeEventListener(TEAM_NAVIGATION_EVENT, onOpen)
  }, [onOpen])
}
