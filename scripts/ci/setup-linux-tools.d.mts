export function verifiedArchive(
  tool: { url: string; sha256: string },
  cache: string,
  fetchArchive?: typeof fetch,
): Promise<Buffer>

export function setupLinuxTools(profile: string, env?: NodeJS.ProcessEnv): Promise<void>
