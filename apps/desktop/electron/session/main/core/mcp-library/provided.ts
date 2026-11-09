import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { integrationPluginRegistry } from '@gugu/session-plugins/integrations';
import { sessionHostLocale } from '@main/core/host-locale';
import { localizedManifestText } from '@shared/extensions/catalog';
import { programName } from '@shared/extensions/manifest';
import type { LibraryMcpCheck, LibraryMcpProvided, LibraryMcpProvidedServer } from '@shared/mcp-library';
import { GUGU_MCP_SERVER_NAME } from '../../../../mcp/gugu-mcp-name.mjs';
import { listConnectedTools } from '../../../../integration-mcp-bridge';
import { extensionServerName } from '../../../../extension-session-mcp';
import { extensionPrograms } from '../extensions/extension-programs';
import { extensionsService } from '../extensions/extensions-root';
import { connectedSessionIntegrations } from '../integrations/session-integrations';

/** 集成那台的名字 —— 与 integration-mcp-bridge 里 `new McpServer({ name: 'connected-apps' })` 同一个。 */
const INTEGRATION_SERVER = 'connected-apps';

/**
 * 「咕咕提供」里递给 agent 的那几台,取自递送本身的来源:集成 = `connectedSessionIntegrations` 汇成的那一台 `connected-apps`;
 * App = `extensionPrograms.installed()`(会话网关递的就是这份程序描述),名字照 `extensionServerName`。❌ 另抄一份。
 * 工具列表在 `providedTools` 里按需取:列 App 的工具会把程序起起来。
 */
export async function libraryMcpProvided(): Promise<LibraryMcpProvided> {
  const servers: LibraryMcpProvidedServer[] = [];
  const integrations = await connectedSessionIntegrations();
  if (integrations.length > 0) {
    servers.push({
      key: 'integrations',
      group: 'integrations',
      name: INTEGRATION_SERVER,
      transport: 'http',
      from: integrations.map(({ integrationId }) => integrationPluginRegistry.get(integrationId)?.metadata.name ?? integrationId),
      reach: 'every-task',
    });
  }
  const extensions = extensionsService();
  const locale = sessionHostLocale();
  for (const program of extensionPrograms.installed()) {
    const refusal = extensionPrograms.agentToolsRefusal(program.extensionId);
    const { manifest } = extensions.get(program.extensionId);
    // 命令照 App 清单里写的(`node launch.mjs`、工具模块 `tools.js`;原生能力没有命令),
    // ❌ 咕咕解析后的那一串(本机的 Electron 路径、快照目录)。
    const declared = (manifest.contributes.mcpServers ?? []).find((entry) => programName(entry, program.extensionId) === program.server);
    servers.push({
      key: `app:${program.extensionId}/${program.server}`,
      group: 'apps',
      name: extensionServerName(program.extensionId, program.server),
      ...(program.native ? {} : { transport: 'stdio' as const }),
      ...(declared && 'command' in declared ? { command: declared.command, ...(declared.args?.length ? { args: declared.args } : {}) } : {}),
      ...(declared && 'tools' in declared ? { command: declared.tools } : {}),
      from: [localizedManifestText(manifest, locale).name],
      reach: refusal ? 'off' : extensions.disclosure(program.extensionId) === 'full' ? 'every-task' : 'on-demand',
      ...(refusal ? { refusal } : {}),
    });
  }
  return { builtIn: [GUGU_MCP_SERVER_NAME], servers };
}

/** 一台的工具列表,和递给 agent 时 `tools/list` 答的是同一份(集成:桥的 `listConnectedTools`;App:`extensionPrograms.tools`)。 */
export async function libraryMcpProvidedTools(key: string): Promise<LibraryMcpCheck> {
  const signal = AbortSignal.timeout(30_000);
  const at = new Date().toISOString();
  const shape = (tools: readonly Tool[]): LibraryMcpCheck => ({
    status: 'ok',
    at,
    tools: tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })),
  });
  if (key === 'integrations') {
    return shape(await listConnectedTools(await connectedSessionIntegrations(), signal, { requestId: 'library' }));
  }
  const program = extensionPrograms.installed().find((item) => `app:${item.extensionId}/${item.server}` === key);
  if (!program) throw new Error(`MCP ${key} is not installed here any more`);
  return shape(await extensionPrograms.tools(program));
}
