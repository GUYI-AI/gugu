import { homedir } from 'node:os';
import { join } from 'node:path';
import { requireNativeHome } from '@gugu/session-plugins/agents';

/** 用户自己的配置根:用户导出了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 就是那里,否则 `~/.claude` / `~/.codex`。 */
export function nativeConfigRoot(providerId: 'claude' | 'codex', env: Record<string, string | undefined> = process.env): string {
  const home = requireNativeHome(providerId);
  return env[home.envVar]?.trim() || join(homedir(), home.userPath);
}
