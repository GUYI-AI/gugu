import { useShownAgentName } from '@/hooks/useShownAgentName'
import { AUTOMATION_TEST_IDS, type AutomationTestId } from '../lib/automationDom'
import { MemberProfileCard, type MemberProfileChatTarget, type MemberProfileEditControls } from './MemberProfileCard'
import type { ActiveMemberProfile, MemberProfileHandle } from './memberProfileModels'
import { useContactsStore } from '../store/contactsContext'
import { useAuth } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { useMobileShell } from '../hooks/useMobileShell'
import { Popover } from './ui/Popover'
import { Sheet } from './ui/Sheet'
import { useTranslation } from 'react-i18next'
import { useState, type ReactNode } from 'react'
import { searchInChat } from '@renderer/features/global-search/search-session'

const adjacentSettingsSelector = '[data-testid="sidebar-profile-button"], [data-testid="sidebar-profile-menu"], [data-testid="sidebar-settings-nav"], [data-testid="settings-panel"]'

function isAdjacentSettingsTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(adjacentSettingsSelector) !== null
}

/** On the phone the card is a bottom sheet, outside the popover: the sheet owns its dismissal, a press in it is not outside. */
function isInProfileSheet(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.gg-sheet-content')?.querySelector('[data-profile-member-id]')
}

/**
 * A host's one profile card. Every avatar / member row that opens it is a `Popover.Trigger` of `handle` with the profile as
 * payload, so Base UI owns the toggle: a second press on the same avatar closes the card, another avatar moves it.
 * `children` draws the card for the opened profile (a `MemberProfilePopover`), so a host can refresh it from its roster.
 */
export function MemberProfileRoot({ handle, onOpenChange, children }: {
  handle: MemberProfileHandle
  onOpenChange?: (open: boolean) => void
  children: (profile: ActiveMemberProfile) => ReactNode
}) {
  // Base UI keeps the last payload after closing (for the exit animation); the phone's bottom sheet is not inside the
  // popover, so the card is drawn only while the card is open.
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root
      handle={handle}
      modal={false}
      onOpenChange={(next, eventDetails) => {
        if (!next) {
          const nextTarget = eventDetails.event instanceof FocusEvent
            ? eventDetails.event.relatedTarget
            : null
          const keepsCard = (target: EventTarget | null) => isAdjacentSettingsTarget(target) || isInProfileSheet(target)
          const staysOpen = (eventDetails.reason === 'outside-press' || eventDetails.reason === 'focus-out')
            && (keepsCard(eventDetails.event.target) || keepsCard(nextTarget))
          if (staysOpen) {
            eventDetails.cancel()
            return
          }
        }
        setOpen(next)
        onOpenChange?.(next)
      }}
    >
      {({ payload }) => open && payload ? children(payload) : null}
    </Popover.Root>
  )
}

/** The card layer inside a `MemberProfileRoot` (a bottom sheet on the phone). */
export function MemberProfilePopover({
  profile,
  onClose: _onClose,
  onOpenChat,
  onWhisper,
  searchChatId,
  editControls,
  testId = AUTOMATION_TEST_IDS.groupMemberProfileMenu,
}: {
  profile: ActiveMemberProfile
  onClose: () => void
  onOpenChat?: (target: MemberProfileChatTarget) => void
  // @@@whisper (#820) — 透传给 MemberProfileCard 的悄悄话回调。
  onWhisper?: (target: MemberProfileChatTarget) => void
  /** The conversation this card was opened in: 「查找 TA 的消息」searches it for this member. */
  searchChatId?: string
  editControls?: MemberProfileEditControls
  testId?: AutomationTestId
}) {
  const { t } = useTranslation('contacts')
  const { user } = useAuth()
  const { identitiesById } = useChatStore('identitiesById')
  // Width matches design .pop { width:284px }
  const width = 284
  const gap = 10
  const { contacts, updateContactAlias } = useContactsStore()
  const contact = contacts.find((item) => item.id === profile.member.id)
  const aliasControls = contact
    ? { alias: contact.alias ?? null, onSave: (alias: string) => updateContactAlias(contact.id, alias) }
    : undefined
  const isSelf = user?.id === profile.member.id
  const bio = profile.member.bio ?? (isSelf ? user.bio : contact?.bio) ?? null
  const email = profile.member.email ?? (isSelf ? user.email : null)
  const displayName = identitiesById[profile.member.id]?.display_name ?? profile.member.displayName
  const enrichedMember = bio !== profile.member.bio || email !== profile.member.email || displayName !== profile.member.displayName
    ? { ...profile.member, displayName, bio, email }
    : profile.member
  const shownName = useShownAgentName({ name: displayName, createdAt: profile.member.type === 'agent' ? identitiesById[profile.member.id]?.created_at ?? undefined : undefined })
  const side = profile.preferredSide ?? 'left'
  const mobile = useMobileShell()
  const ariaLabel = t('profile.profileDialog', { name: shownName })
  const findMessages = searchChatId ? () => { _onClose(); searchInChat(searchChatId, { userId: profile.member.id, name: displayName }) } : undefined
  const card = <MemberProfileCard member={enrichedMember} onOpenChat={onOpenChat} onWhisper={onWhisper} onFindMessages={findMessages} editControls={editControls} aliasControls={aliasControls} fill={mobile} />
  const memberData = { 'data-profile-member-id': profile.member.id, 'data-profile-member-type': profile.member.type, 'data-profile-member-role': profile.member.role }

  // 手机是共用的底部面板(#6836):贴着锚点的 284 宽卡片在整行宽的成员页上左右都放不下,会整张落在屏外。
  if (mobile) {
    return (
      <Sheet onClose={_onClose} mobileFitContent testId={testId} ariaLabel={ariaLabel}>
        <div {...memberData}>{card}</div>
      </Sheet>
    )
  }

  // @@@no-close-x - Base UI handles outside press + Escape; the corner X was redundant.
  return (
    <Popover.Portal>
      <Popover.Positioner
        positionMethod="fixed"
        side={side}
        align="start"
        sideOffset={gap}
        alignOffset={-8}
        collisionPadding={8}
        collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
      >
        <Popover.Popup
          role="dialog"
          aria-label={ariaLabel}
          data-testid={testId}
          {...memberData}
          style={{ width }}
        >
          {card}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  )
}
