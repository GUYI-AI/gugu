import { i18n } from '@/i18n'

/**
 * The one label the chat gives a member it cannot name: an id the directory does not know, or an account that was
 * deleted. The forward picker, the question card and chat notifications all take it from here, so they cannot drift.
 */
export const unknownMemberName = (): string => i18n.t('group.memberFallback.unknown', { ns: 'messaging' })

/**
 * What an identity that was removed is called on what it already said: its own name, marked removed (owner, #4028),
 * so people still know who spoke. The sender row, the quote head and a message link all take it from here. Only the
 * shown text changes: the profile keeps the bare name, which @mention matching and avatars read.
 */
export const shownMemberName = (name: string, removedAt: string | null | undefined): string =>
  removedAt && name ? i18n.t('message.removedMemberName', { ns: 'messaging', name }) : name
