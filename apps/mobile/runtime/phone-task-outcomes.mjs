/** Changes to custody must invalidate an incremental projection even when Pi's
 * bytes did not change (for example a durable retry receipt after a lost ACK). */
export function phoneInterruptionRevision(jobs, retriedJobIds = []) {
  return JSON.stringify([jobs.filter(job => job.status === 'interrupted').map(job => job.id ?? job.context?.jobId).sort(),
    [...new Set([...retriedJobIds, ...jobs.map(job => job.retryOf).filter(Boolean)])].sort()])
}

/** The phone ledger owns interruption, even when Pi recorded a terminal event before
 * the process lost custody. Join by actual input-record identity, never prompt text. */
export function projectPhoneTaskOutcomes(turns, inputJobs, jobs, retriedJobIds = []) {
  const byId = new Map(jobs.map(job => [job.id ?? job.context?.jobId, job]))
  const retried = new Set(retriedJobIds)
  for (const job of jobs) if (job.retryOf) retried.add(job.retryOf)
  return turns.map(turn => {
    const jobId = turn.items.filter(item => item.kind === 'message' && item.role === 'user')
      .map(item => inputJobs.get(item.id.split(':message:').at(-1))).findLast(Boolean)
    if (!jobId || byId.get(jobId)?.status !== 'interrupted') return turn
    return { ...turn, outcome: { kind: 'error', reason: 'process_closed',
      phoneInterruption: { jobId, retryable: !retried.has(jobId) } } }
  })
}
