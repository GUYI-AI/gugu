import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { eq } from 'drizzle-orm';
import { pluginRegistry, stripLegacyCodexNotify } from '@gugu/session-plugins/agents';
import type { AgentHomeGroupId } from '@gugu/session-core/agents/plugins';
import {
  diffAgentHome, importAgentHome, reimportAgentHome, resolveAgentHome,
  scanAgentHome, stripManagedJsonHooks, updateAgentHomeSource, type AgentHomeImportIssue,
} from '@gugu/session-core/agents/plugins/helpers';
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { ensureAgentDependenciesProbed, localDependencyManager } from '@main/core/dependencies/dependency-managers';
import { loginShellEnv } from '@main/utils/userEnv';
import type { DependencyId } from '@gugu/session-core/deps/runtime';
import { migrateOwnedHarnessAccounts } from './harness-connections';

/** Declarations own paths; this service adds desktop account migration and IPC-safe metadata. */
function homeFor(providerId: string) {
  const bundle = pluginRegistry.get(providerId)?.capabilities.sessionBundle;
  if (!bundle?.configRoot) return null;
  return resolveAgentHome({ providerId, injectionMode: bundle.injectionMode, configRoot: bundle.configRoot,
    guguHome: process.env.GUGU_HOME ?? '', osHomeDir: homedir(), sourceEnv: { ...process.env, ...loginShellEnv() } });
}
function hasOldTasks(providerId: string): boolean {
  return db.select({ id: sessions.id }).from(sessions).where(eq(sessions.provider, providerId)).limit(1).all().length > 0;
}

export async function scanAgentHomes(providerIds?: readonly string[]): Promise<AgentHomeScan[]> {
  const rows: AgentHomeScan[] = [];
  if (!providerIds) await ensureAgentDependenciesProbed(localDependencyManager);
  for (const plugin of pluginRegistry.getAll()) {
    const providerId = plugin.metadata.id;
    if (providerIds ? !providerIds.includes(providerId) : localDependencyManager.get(providerId as DependencyId)?.status !== 'available') continue;
    const home = homeFor(providerId);
    if (!home) continue;
    const scan = await scanAgentHome(home);
    const migration = !scan.marker && hasOldTasks(providerId);
    const sourceReadable = await access(home.userConfigRoot).then(() => true, () => scan.groups.some((group) => group.count > 0));
    rows.push({
      providerId, name: plugin.metadata.name, userRoot: home.userConfigRoot, sourceReadable,
      importedAt: scan.marker?.importedAt ?? null, needsImport: !scan.marker,
      sourceUpdated: !!scan.marker && scan.newestMtime > Date.parse(scan.marker.importedAt),
      migration,
      groups: scan.groups, issues: scan.issues, mcpSecrets: scan.mcpSecrets, projectMcpCount: scan.projectMcpCount,
      ...(migration ? { unmarkedMcp: scan.mcpNames } : {}),
    });
  }
  return rows;
}
const imports = new Map<string, ReturnType<typeof importHarnessHomeOnce>>();

export async function importHarnessHome(providerId: string, groups: readonly AgentHomeGroupId[]) {
  const home = homeFor(providerId);
  if (!home) throw new Error('This harness has no managed configuration root');
  const existing = imports.get(home.configRoot);
  if (existing) return existing;
  const pending = importHarnessHomeOnce(home, providerId, groups);
  imports.set(home.configRoot, pending);
  try { return await pending; }
  finally { imports.delete(home.configRoot); }
}

async function importHarnessHomeOnce(home: NonNullable<ReturnType<typeof homeFor>>, providerId: string, groups: readonly AgentHomeGroupId[]) {
  const migration = hasOldTasks(providerId);
  const historyPaths = migration && groups.length
    ? providerId === 'claude' ? ['projects', 'file-history', 'todos'] : providerId === 'codex' ? ['sessions'] : []
    : [];
  let notice: { terminalNeedsSignIn: boolean; relogin: { connectionId: string; name: string; methodId: string }[] } | undefined;
  let cleanupIssue: AgentHomeImportIssue | undefined;
  const result = await importAgentHome(home, {
    groups: new Set(groups), ...(migration ? { migratedFrom: 'shared' as const, historyPaths } : {}),
    beforeCommit: async () => {
      if (providerId === 'claude' || providerId === 'codex') notice = await migrateOwnedHarnessAccounts(providerId, { ...process.env, ...loginShellEnv() });
      // Existing markers are the only proof an entry belongs to Gugu. No MCP names are guessed.
      if (providerId === 'claude') cleanupIssue = await updateAgentHomeSource(home, 'settings.local.json',
        (fs, path) => stripManagedJsonHooks(fs, path, 'user'));
      if (providerId === 'codex') cleanupIssue = await updateAgentHomeSource(home, 'config.toml', async (fs, path) => {
        const original = (await fs.read(path))!;
        const stripped = stripLegacyCodexNotify(original);
        if (stripped !== original) await fs.write(path, stripped);
      });
    },
  });
  const issues = cleanupIssue && !result.issues.some((item) => item.path === cleanupIssue?.path && item.reason === cleanupIssue?.reason)
    ? [...result.issues, cleanupIssue] : result.issues;
  return { issues, ...notice,
    oldSessionsSkipped: result.issues.filter((issue) => issue.reason === 'tooLarge' && historyPaths.some((path) => issue.path.startsWith(`${path}/`))).length };
}
export async function diffHarnessHome(providerId: string) {
  const home = homeFor(providerId);
  if (!home) throw new Error('This harness has no managed configuration root');
  return diffAgentHome(home);
}
export async function reimportHarnessHome(providerId: string, decisions: readonly { id: string; revision: string }[]) {
  const home = homeFor(providerId);
  if (!home) throw new Error('This harness has no managed configuration root');
  return reimportAgentHome(home, new Set(decisions.map((entry) => entry.id)), new Map(decisions.map((entry) => [entry.id, entry.revision])));
}
