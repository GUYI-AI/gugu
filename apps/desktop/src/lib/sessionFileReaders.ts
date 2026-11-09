/**
 * An owner-notification file stays on the session's machine. Each task timeline already reads its pictures one way
 * (desktop: that machine's `app.readUserImageDataUrl`; phone: the same call over the device link). While a timeline is
 * drawn it lends that very reader here, under its session; nothing else reads these files.
 */
const readers = new Map<string, (path: string) => Promise<string | null>>()

export function lendSessionFileReader(sessionId: string, read: (path: string) => Promise<string | null>): () => void {
  readers.set(sessionId, read)
  return () => { if (readers.get(sessionId) === read) readers.delete(sessionId) }
}

export const sessionFileReader = (sessionId: string | null) => (sessionId ? readers.get(sessionId) : undefined)
