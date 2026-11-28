/** The host's reported status is independent of whether it accepted this message. */
export function agentReceiptNote(status: string | null): string | null {
  return status === 'error' ? 'Agent reported an error' : null
}
