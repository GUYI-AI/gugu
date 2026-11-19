import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from '@gugu/core'
import { assertSameTeamFunding, TeamFundingError, type TeamTaskIdentity } from './team-model-funding'

export interface TaskPayer {
  version: 1
  taskId: string
  actorUserId: string
  kind: 'personal' | 'team'
  teamId?: string
  memberIdentityId?: string
  teamTask?: TeamTaskIdentity
}
function samePayer(left: TaskPayer, right: TaskPayer) {
  return left.taskId === right.taskId && left.actorUserId === right.actorUserId && left.kind === right.kind
    && left.teamId === right.teamId && left.memberIdentityId === right.memberIdentityId
}

/** Secret-free task ownership survives ticket settlement and app restarts. A new account cannot fund an old task. */
export function createTaskPayerStore(home: string) {
  const directory = join(home, 'task-funding')
  const path = (taskId: string) => join(directory, `${createHash('sha256').update(taskId).digest('hex')}.json`)
  async function read(taskId: string): Promise<TaskPayer | null> {
    let raw: string
    try { raw = await readFile(path(taskId), 'utf8') }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause }
    const row = JSON.parse(raw) as TaskPayer
    if (row.version !== 1 || row.taskId !== taskId || typeof row.actorUserId !== 'string'
      || !['personal', 'team'].includes(row.kind) || (row.kind === 'team' && (!row.teamId || !row.memberIdentityId))) throw new TeamFundingError('team_identity_required')
    return row
  }
  return {
    read,
    async reserve(payer: TaskPayer): Promise<TaskPayer> {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const candidate = `${path(payer.taskId)}.${randomUUID()}.tmp`
      await writeFile(candidate, JSON.stringify(payer), { flag: 'wx', mode: 0o600 })
      try { await link(candidate, path(payer.taskId)); return payer }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
      finally { await rm(candidate, { force: true }) }
      const existing = await read(payer.taskId)
      if (!existing || !samePayer(existing, payer)) throw new TeamFundingError('team_identity_required')
      return existing
    },
    async lockTeam(taskId: string, identity: TeamTaskIdentity) {
      const existing = await read(taskId)
      if (!existing || existing.kind !== 'team' || existing.actorUserId !== identity.actorUserId
        || existing.teamId !== identity.funding.team_id || existing.memberIdentityId !== identity.memberIdentityId
        || identity.funding.task_id !== taskId) throw new TeamFundingError('team_identity_required')
      if (existing.teamTask) assertSameTeamFunding(identity.funding, existing.teamTask.funding)
      await atomicWriteText(path(taskId), JSON.stringify({ ...existing, teamTask: identity }))
    },
  }
}
