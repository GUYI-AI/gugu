// #1931 The host's half of the assistant workflow: wrapping a dispatch in the work order. The words are the product's (the
// rules' `task-execution` text, supplied by the assistant App); the caller passes the rules it resolved.
import type { AssistantProductRules } from './assistantRulesFormat'

/** Host-owned work order, applied before routing to either a local or a remote executor. */
export function assistantExecutionAction(action: unknown, rules: AssistantProductRules): unknown {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action
  const record = action as Record<string, unknown>
  if(record.action==='message'&&record.purpose==='reply')return action
  const execution = rules.texts['task-execution']
  const field = record.action === 'spawn' ? 'prompt' : record.action === 'message' ? 'text' : null
  if (!field || typeof record[field] !== 'string' || record[field].includes(execution)) return action
  return { ...record, [field]: `${record[field]}\n\n<gugu_task_context>\n${execution}\n</gugu_task_context>` }
}
