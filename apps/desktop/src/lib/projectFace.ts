import { createContext } from 'react'

/**
 * Whether the group face drawn below is a project's. Set by a surface that knows from somewhere the face itself cannot
 * read (the phone's message list, which knows its project rows from the account's projects); undefined = not said, and
 * the face goes by the projects this computer has bound.
 */
export const ProjectFaceContext = createContext<boolean | undefined>(undefined)
