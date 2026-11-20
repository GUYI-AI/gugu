import { createContext } from 'react'

/** The part of a row content-visibility skips (MessageRow): everything but the row's avatar track. */
export const ROW_BODY_ATTR = 'data-row-body'

/**
 * @@@avatar-track — a group's avatar is drawn on a track in the row element, before the row's body, ❌ inside the body: the
 * body is content-visibility:auto, whose paint containment would clip a track that reaches up to the group's first bubble,
 * and skip it with the row. MessageRow hosts the track (drawn only while the row's avatar asks for one); StickyGroupAvatar
 * portals the avatar onto it and places it.
 */
export type AvatarTrackHost = { track: HTMLDivElement | null; want: (wanted: boolean) => void }
export const AvatarTrackContext = createContext<AvatarTrackHost | null>(null)
