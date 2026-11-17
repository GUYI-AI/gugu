// Only locally declared codes may cross the renderer log boundary. Remote messages,
// stacks and arbitrary code strings can contain host paths, filenames or credentials.
const diagnosticCodes = new Set([
  'attachment_creation_unverified', 'creation_attachments_pending',
  'creation_attachments_unconfirmed', 'creation_attachments_account_changed',
  'creation_attachments_original_missing', 'phone_create_rejected',
  'host_update_required', 'unknown_method', 'method_not_found',
  'harness_install_failed', 'harness_runtime_missing', 'harness_not_found',
  'agent_signed_out', 'model_rejected', 'permission_mode_rejected',
  'session_view_rejected', 'project_not_found', 'project_open_failed',
  'project_not_open', 'device_offline', 'timeout', 'unreachable',
  'attachment_missing', 'attachment_incomplete', 'invalid_attachment',
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ENOSPC', 'EIO',
])

export function creationFailureDiagnostic(code: string | null): { code: string } {
  return { code: code !== null && diagnosticCodes.has(code) ? code : 'unknown_creation_failure' }
}
