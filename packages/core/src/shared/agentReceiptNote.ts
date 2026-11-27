/** A sender sees only confirmed exceptions. The delivery result itself owns admission and retry semantics. */
export function agentReceiptNote(status: string | null, hostOnline?: boolean | null, lastSeen?: string | null, host = 'Host'): string | null {
  if (status === 'archived') return null
  if (hostOnline === false) {
    const time = lastSeen && Number.isFinite(Date.parse(lastSeen)) ? new Date(lastSeen).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null
    return `${host} offline${time ? ` (last seen ${time})` : ''}`
  }
  if (hostOnline === null) return null
  if (status === 'error') return 'Agent reported an error'
  return null
}
