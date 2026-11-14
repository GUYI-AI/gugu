import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, SquarePen, UserPlus } from '@/lib/icons'
import { UI_EVENTS } from '../../lib/uiEvents'
import { platform } from '../../platform'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../session/renderer/lib/ui/tooltip'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu, MenuItem } from '../ui/Menu'
import { GroupAddMembersSheet } from './GroupAddMembersSheet'

/** The composer's 「新任务」 outside a block (ComposerVerbs): the shell puts that group up with its new-agent composer. */
const newAgentInGroup = (chatId: string) => window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } }))

/**
 * A group's one 「+」(owner 11-14): the inner column's head row (on hover), the info page's members row and the members
 * page's title all draw this. Two items: 「添加成员」 = the one member picker (people and existing agents, GroupAddMembersSheet),
 * 「新建 Agent」 = the group's new-agent entry. An item the viewer cannot use is not drawn; with neither, no 「+」.
 * The picker opens over whatever page the 「+」 is on, so closing it lands back there.
 */
export function GroupAddMenu({ chatId, canAddMembers, onNewAgent = () => newAgentInGroup(chatId), size = 'md', className }: {
  chatId: string
  /** groupInviteAccess(...).showInvite where the settings are at hand. */
  canAddMembers: boolean
  onNewAgent?: () => void
  size?: 'sm' | 'md'
  className?: string
}) {
  const { t } = useTranslation('messaging')
  const [picking, setPicking] = useState(false)
  const canNewAgent = platform.capabilities.sessionHost
  if (!canAddMembers && !canNewAgent) return null
  const label = t('group.memberList.add')
  return <>
    <DropdownMenu.Root modal={false}>
      <Tooltip>
        <DropdownMenu.Trigger render={<TooltipTrigger render={
          <IconButton size={size} tone="strong" aria-label={label} data-group-add-menu="" className={className}><Plus /></IconButton>
        } />} />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {/* The menu closing ❌ hands focus back to the 「+」: the picker it opened has taken it (and Escape with it). */}
      <DropdownMenu.Content side="bottom" align="end" sideOffset={4} className="min-w-40" finalFocus={false}>
        {canAddMembers ? <MenuItem icon={<UserPlus size={16} />} data-testid="group-add-members" onClick={() => setPicking(true)}>{t('group.memberList.addMembers')}</MenuItem> : null}
        {canNewAgent ? <MenuItem icon={<SquarePen size={16} />} data-testid="group-add-new-agent" onClick={onNewAgent}>{t('group.memberList.newAgent')}</MenuItem> : null}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {picking ? <GroupAddMembersSheet chatId={chatId} onClose={() => setPicking(false)} /> : null}
  </>
}
