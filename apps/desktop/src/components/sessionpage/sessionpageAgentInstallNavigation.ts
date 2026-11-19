import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'

type BooleanSetter = Dispatch<SetStateAction<boolean>>
type TabSetter = (tab: SidebarTab) => void

export function useSessionpageAgentInstallNavigation(
  enabled: boolean,
  composerOpen: boolean,
  setSessionCreateOpen: BooleanSetter,
  setActiveTab: TabSetter,
) {
  useEffect(() => {
    if (!enabled) return
    const w = window as typeof window & {
      __GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__?: (agentId: string) => boolean
      __GUGU_RESTORE_SESSIONPAGE_AGENT_INSTALL__?: () => void
    }
    w.__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__ = () => {
      setSessionCreateOpen(false)
      setActiveTab('tasks')
      return composerOpen
    }
    w.__GUGU_RESTORE_SESSIONPAGE_AGENT_INSTALL__ = () => {
      setActiveTab('chats')
      setSessionCreateOpen(true)
    }
    return () => {
      delete w.__GUGU_OPEN_SESSIONPAGE_AGENT_INSTALL__
      delete w.__GUGU_RESTORE_SESSIONPAGE_AGENT_INSTALL__
    }
  }, [enabled, composerOpen, setActiveTab, setSessionCreateOpen])
}
