import { useTranslation } from 'react-i18next'
import { Plus, SquarePen, UserPlus } from '@/lib/icons'
import { openGroupMemberPicker, UI_EVENTS } from '../../lib/uiEvents'
import { platform } from '../../platform'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../session/renderer/lib/ui/tooltip'
import { IconButton } from '../ui/IconButton'
import { DropdownMenu, MenuItem } from '../ui/Menu'

/** The shell opens the creation composer for this group. */
const newAgentInGroup = (chatId: string) => window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } }))

/**
 * A group's 「+」(owner 11-14): the info page's members row and the members page's title both draw this. Two items: 「添加成员」 = the one member picker (people and existing agents, GroupAddMembersHost),
 * 「新建 Agent」 = the group's new-agent entry. An item the viewer cannot use is not drawn; with neither, no 「+」.
 * The picker opens over whatever page the 「+」 is on, so closing it lands back there.
 */
export function GroupAddMenu({ chatId, canAddMembers, onNewAgent = () => newAgentInGroup(chatId), size = 'md', className, labeled = false }: {
  chatId: string
  /** groupInviteAccess(...).showInvite where the settings are at hand. */
  canAddMembers: boolean
  onNewAgent?: () => void
  size?: 'sm' | 'md'
  className?: string
  /** 详情页的群成员块(第 16 版):「+ 添加」一枚小字钮,同一个菜单。 */
  labeled?: boolean
}) {
  const { t } = useTranslation('messaging')
  const canNewAgent = platform.capabilities.sessionHost
  if (!canAddMembers && !canNewAgent) return null
  const label = t('group.memberList.add')
  return (
    <DropdownMenu.Root modal={false}>
      <Tooltip>
        <DropdownMenu.Trigger render={<TooltipTrigger render={labeled
          ? <button type="button" aria-label={label} data-group-add-menu="" className="inline-flex h-[22px] items-center gap-[5px] rounded-full px-2 text-[12px] text-[var(--muted-fg)] hover:bg-row-hover"><Plus size={12} />{label}</button>
          : <IconButton size={size} tone="strong" aria-label={label} data-group-add-menu="" className={className}><Plus /></IconButton>
        } />} />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {/* The menu closing ❌ hands focus back to the 「+」: the picker it opened has taken it (and Escape with it). */}
      <DropdownMenu.Content side="bottom" align="end" sideOffset={4} className="min-w-40" finalFocus={false}>
        {canAddMembers ? <MenuItem icon={<UserPlus size={16} />} data-testid="group-add-members" onClick={() => openGroupMemberPicker(chatId)}>{t('group.memberList.addMembers')}</MenuItem> : null}
        {canNewAgent ? <MenuItem icon={<SquarePen size={16} />} data-testid="group-add-new-agent" onClick={onNewAgent}>{t('group.memberList.newAgent')}</MenuItem> : null}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}
