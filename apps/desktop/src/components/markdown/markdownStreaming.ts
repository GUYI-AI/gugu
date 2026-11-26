import { createContext } from 'react'

/**
 * Text arriving as it is written (a live reply): Markdown fades its letters in one after another as they land — ArcMD's
 * answer stream, itself LobeHub's Streamdown char animation. Settled text never animates, so a finished message drawn
 * again (scrolling back, a reload) is just there.
 */
export const MarkdownStreamingContext = createContext(false)
