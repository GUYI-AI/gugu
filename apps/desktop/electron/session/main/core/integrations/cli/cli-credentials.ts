import { execFile } from '@gugu/core/local/childProcess';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { cliToolEnv } from './cli-login';
import { ensureCliTool, installedCliTool } from './cli-tool-installer';
import { cliToolRecipe } from './cli-tools';
import type { IntegrationCliTool } from '@gugu/session-plugins/integrations';

/** v1.0.68 Windows credentials remain in the directory-derived registry
 * namespace. Removing files alone would leave the authorization usable. */
export async function removeCliCredentials(tool: IntegrationCliTool): Promise<void> {
  const recipe = cliToolRecipe(tool);
  if (process.platform === 'win32' && tool === 'dws') {
    const installed = await ensureCliTool(tool);
    await fs.mkdir(installed.homeDir, { recursive: true });
    try {
      await promisify(execFile)(installed.binPath, ['auth', 'reset'], {
        env: cliToolEnv(recipe, installed), windowsHide: true, timeout: 15_000,
      });
    } catch (cause) {
      throw new Error('钉钉登录信息未能清除，请重试断开连接。', { cause });
    }
  }
  await fs.rm(installedCliTool(tool).homeDir, { recursive: true, force: true });
}
