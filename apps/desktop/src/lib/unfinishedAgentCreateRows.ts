import { defaultResumeStore } from './agentProvision'
import { replica } from './replica'

/** Display-only replica of the existing durable intents; no second persisted copy or cloud replay. */
export const readUnfinishedAgentRows = (owner: string) => defaultResumeStore.list(owner)
  .filter(record => record.blueprint.kind === 'single')
  .map(record => ({ operationId: record.operationId, name: record.blueprint.members[0].display_name }))

export const unfinishedAgentCreateRows = replica({
  name: 'unfinished-agent-create-rows',
  scope: 'account',
  local: readUnfinishedAgentRows,
  read: async (owner: string) => readUnfinishedAgentRows(owner),
  fresh: Infinity,
  retry: 0,
})
