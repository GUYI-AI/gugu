import { sessionHostCopy } from '../../host-copy';

/** Vendor stderr is diagnostic data, not localized UI copy. Keep it in logs;
 * return an actionable message in the host's language at the connection boundary. */
export function cliFailureMessage(error: unknown, action: 'install' | 'login' | 'verify'): string {
  const detail = error instanceof Error ? error.message : String(error);
  const copy = sessionHostCopy().integrations;
  if (/尚未.*实现|尚不支持/.test(detail)) return copy.notImplemented;
  if (/integrity|checksum|摘要|校验/i.test(detail)) return copy.integrityFailed;
  if (/EACCES|EPERM|permission denied|access.*denied/i.test(detail)) return copy.permissionDenied;
  if (/ENOSPC|disk full|磁盘空间/i.test(detail)) return copy.diskFull;
  if (/secure storage|keychain|credential store/i.test(detail)) return copy.secureStorage;
  if (/timeout|timed out|stalled|超时/i.test(detail)) return copy.timeout;
  return action === 'install' ? copy.installFailed : action === 'login' ? copy.loginStartFailed : copy.verifyFailed;
}
