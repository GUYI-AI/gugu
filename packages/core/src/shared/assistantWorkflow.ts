// #1931 The host's half of the assistant workflow: wrapping a dispatch in the work order. The rules' words live in
// ./assistantProductRules/workflow.ts and reach the host through an AssistantProductRules (the built-in one today).
import { BUILT_IN_ASSISTANT_RULES } from './assistantProductRules/builtIn'
import { ASSISTANT_WORKFLOW_LINES } from './assistantProductRules/workflow'
import { renderAssistantRule, type AssistantProductRules } from './assistantRulesFormat'

export { ASSISTANT_CONTEXT_CORE, ASSISTANT_TASK_EXECUTION, OWNER_PROFILE_WRITING_RULES } from './assistantProductRules/workflow'
export { PROFILE_RULES_VERSION } from './assistantProductRules/defaults'

/** The handbook's coordination sections as the built-in guide renders them. */
export const ASSISTANT_WORKFLOW: readonly string[] = ASSISTANT_WORKFLOW_LINES.map(line =>
  renderAssistantRule(line, { profileRulesVersion: String(BUILT_IN_ASSISTANT_RULES.defaults.profileRulesVersion) }))

/** Host-owned work order, applied before routing to either a local or a remote executor. */
export function assistantExecutionAction(action: unknown, rules: AssistantProductRules = BUILT_IN_ASSISTANT_RULES): unknown {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action
  const record = action as Record<string, unknown>
  if(record.action==='message'&&record.purpose==='reply')return action
  const execution = rules.texts['task-execution']
  const field = record.action === 'spawn' ? 'prompt' : record.action === 'message' ? 'text' : null
  if (!field || typeof record[field] !== 'string' || record[field].includes(execution)) return action
  return { ...record, [field]: `${record[field]}\n\n<gugu_task_context>\n${execution}\n</gugu_task_context>` }
}
