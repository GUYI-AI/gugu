/**
 * An owner-notification file stays on the session's machine, in the session's folder (which need not be under home). A
 * task timeline reads it the way it reads any file its session handed to people: that machine's session file read,
 * which admits the files the session's own records name. While a timeline is drawn it lends that reader here, under its
 * session; nothing else reads these files.
 */
const readers = new Map<string, (path: string) => Promise<Blob>>()

export function lendSessionFileReader(sessionId: string, read: (path: string) => Promise<Blob>): () => void {
  readers.set(sessionId, read)
  return () => { if (readers.get(sessionId) === read) readers.delete(sessionId) }
}

export const sessionFileReader = (sessionId: string | null) => (sessionId ? readers.get(sessionId) : undefined)
