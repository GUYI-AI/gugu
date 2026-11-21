import { i18n } from '@/i18n'

/**
 * The one label the chat gives a member it cannot name: an id the directory does not know, or an account that was
 * deleted. The forward picker, the question card and chat notifications all take it from here, so they cannot drift.
 */
export const unknownMemberName = (): string => i18n.t('group.memberFallback.unknown', { ns: 'messaging' })
