/** Vendor stderr is diagnostic data, not localized UI copy. Keep it in logs;
 * return an actionable Chinese message at the connection boundary. */
export function cliFailureMessage(error: unknown, action: 'install' | 'login' | 'verify'): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/尚未.*实现|尚不支持/.test(detail)) return '这个集成尚未在这台设备上实现，请选择其他设备。';
  if (/integrity|checksum|摘要|校验/i.test(detail)) return '下载的工具校验未通过，请重试安装。';
  if (/EACCES|EPERM|permission denied|access.*denied/i.test(detail)) return '没有权限访问集成工具的目录，请检查目录权限后重试。';
  if (/ENOSPC|disk full|磁盘空间/i.test(detail)) return '磁盘空间不足，请清理后重试。';
  if (/secure storage|keychain|credential store/i.test(detail)) return '无法保存授权信息，请检查安全存储后重试。';
  if (/timeout|timed out|stalled|超时/i.test(detail)) return '连接超时，请检查网络后重试。';
  return action === 'install' ? '集成工具安装失败，请检查网络后重试。'
    : action === 'login' ? '未能启动授权，请检查网络后重新连接。' : '未能确认授权状态，请重新连接。';
}
