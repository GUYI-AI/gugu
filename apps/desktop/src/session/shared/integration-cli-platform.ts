import type { IntegrationCliTool } from '@gugu/session-plugins/integrations';

export type CliPlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64' | 'win32-x64';
export type CliExecutionHost = { platform: string; arch: string };

export function cliPlatform({ platform, arch }: CliExecutionHost): CliPlatform | undefined {
  const key = `${platform}-${arch}`;
  if (key === 'darwin-arm64' || key === 'darwin-x64' || key === 'linux-arm64' || key === 'linux-x64' || key === 'win32-x64') return key;
}

/** Published binaries alone are insufficient: credentials and disconnect must
 * also be isolated from a separately installed vendor CLI. */
export function cliToolSupportsHost(tool: IntegrationCliTool, host: CliExecutionHost): boolean {
  const platform = cliPlatform(host);
  return !!platform && (platform !== 'win32-x64' || tool === 'dws' || tool === 'wecom-cli');
}

export function supportedCliIntegrations<T extends { auth: { methods: { kind: string; tool?: IntegrationCliTool }[] } }>(
  entries: readonly T[], host: CliExecutionHost | null | undefined
): T[] {
  if (!host) return [...entries];
  return entries.flatMap(entry => {
    const methods = entry.auth.methods.filter(method => method.kind !== 'cli' || !!method.tool && cliToolSupportsHost(method.tool, host));
    return methods.length ? [{ ...entry, auth: { ...entry.auth, methods } }] : [];
  });
}
