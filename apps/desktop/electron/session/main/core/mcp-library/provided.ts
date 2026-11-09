import { integrationPluginRegistry } from '@gugu/session-plugins/integrations';
import { sessionHostLocale } from '@main/core/host-locale';
import { localizedManifestText } from '@shared/extensions/catalog';
import type { LibraryMcpProvided } from '@shared/mcp-library';
import { GUGU_MCP_SERVER_NAME } from '../../../../mcp/gugu-mcp-name.mjs';
import { extensionPrograms } from '../extensions/extension-programs';
import { extensionsService } from '../extensions/extensions-root';
import { connectedSessionIntegrations } from '../integrations/session-integrations';

/**
 * 「咕咕提供」里另外三组:读的就是开会话时用的那几个来源(集成:`connectedSessionIntegrations`;App:装着的扩展和
 * `agentToolsRefusal`),❌ 另抄一份名单 —— MCP 页和会话看见的是同一份。
 */
export async function libraryMcpProvided(): Promise<LibraryMcpProvided> {
  const integrations = (await connectedSessionIntegrations()).map(({ integrationId }) => ({
    id: integrationId,
    name: integrationPluginRegistry.get(integrationId)?.metadata.name ?? integrationId,
  }));
  const extensions = extensionsService();
  const locale = sessionHostLocale();
  const apps = extensions
    .list()
    .extensions.filter(({ manifest }) => (manifest.contributes.mcpServers ?? []).length > 0)
    .map(({ manifest }) => ({
      id: manifest.id,
      name: localizedManifestText(manifest, locale).name,
      disclosure: extensions.disclosure(manifest.id),
      refusal: extensionPrograms.agentToolsRefusal(manifest.id),
    }));
  return { builtIn: [GUGU_MCP_SERVER_NAME], integrations, apps };
}
