import { isAgentHomeImportCode } from '@gugu/session-core/workspace-server/agent-config';

/** No request fields, remote prose, paths or session identifiers belong in creation logs. */
const codes = new Set([
  'create_options_failed', 'create_models_failed', 'create_task_failed', 'effort_rejected',
  'fast_rejected', 'folder_not_in_project', 'harness_install_failed', 'harness_not_found',
  'harness_runtime_missing', 'permission_mode_rejected', 'project_not_found',
  'project_not_open', 'project_open_failed', 'prompt_empty', 'session_not_found',
  'session_view_rejected', 'session_start_failed', 'model_rejected', 'agent_signed_out', 'platform_model_unreachable',
]);
export function createFailureLogFields(code: string, retry = false) {
  return { scope: 'session-timeline/create', code: codes.has(code) || isAgentHomeImportCode(code) ? code : 'unknown_creation_failure', retry: retry === true };
}
