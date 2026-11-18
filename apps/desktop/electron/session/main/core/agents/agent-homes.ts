import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { eq } from 'drizzle-orm';
import { pluginRegistry, stripLegacyCodexNotify } from '@gugu/session-plugins/agents';
import type { AgentHomeGroupId } from '@gugu/session-core/agents/plugins';
import {
  AgentHomeNotImported, diffAgentHome, importAgentHome, readAgentHomeMarker, reimportAgentHome, resolveAgentHome,
  scanAgentHome, stripManagedJsonHooks, updateAgentHomeSource, type AgentHomeImportIssue, type AgentHomeMarker,
} from '@gugu/session-core/agents/plugins/helpers';
import { agentHomeOperationSchema, type AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { sessions } from '@main/db/schema';
import { ensureAgentDependenciesProbed, localDependencyManager } from '@main/core/dependencies/dependency-managers';
import { log } from '@main/lib/logger';
import { loginShellEnv } from '@main/utils/userEnv';
import type { DependencyId } from '@gugu/session-core/deps/runtime';
import { migrateOwnedHarnessAccounts } from './harness-connections';
import { setAgentHomeUpgradePreparation } from './agent-home';

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

const upgradeState = new KV<{ providers: string[] }>('agent-home-upgrade');
let upgradeProviders: Promise<ReadonlySet<string>> | undefined;

async function planUpgrade(priorProfile: boolean): Promise<ReadonlySet<string>> {
  const previous = await upgradeState.get('providers');
  if (previous) return new Set(previous);
  const ids: string[] = [];
  if (priorProfile) await ensureAgentDependenciesProbed(localDependencyManager);
  for (const plugin of pluginRegistry.getAll()) {
    const id = plugin.metadata.id;
    if (!plugin.capabilities.sessionBundle?.configRoot) continue;
    if (priorProfile && localDependencyManager.get(id as DependencyId)?.status === 'available' || hasOldTasks(id)) ids.push(id);
  }
  // Snapshot the pre-upgrade installation once. A harness installed after this boot is a new import.
  await upgradeState.setOrThrow('providers', ids);
  return new Set(ids);
}

export function initializeAgentHomeUpgrade(priorProfile: boolean): void {
  if (upgradeProviders) return;
  upgradeProviders = planUpgrade(priorProfile);
  setAgentHomeUpgradePreparation(prepareAutomaticImport);
  void upgradeProviders.then((ids) => Promise.allSettled([...ids].map(prepareAutomaticImport))).catch(() => {
    log.error('Could not plan the managed configuration upgrade');
  });
}

async function prepareAutomaticImport(providerId: string): Promise<void> {
  try {
    if (!(await upgradeProviders)?.has(providerId)) return;
    const home = homeFor(providerId);
    if (!home || await readAgentHomeMarker(home)) return;
    await importHarnessHome(providerId, defaultAgentHomeGroups(home.importGroups));
  } catch (error) {
    log.error('Automatic harness configuration import failed', { providerId });
    throw new AgentHomeNotImported(providerId, { cause: error });
  }
}

export function defaultAgentHomeGroups(groups: readonly { id: AgentHomeGroupId }[]): AgentHomeGroupId[] {
  return groups.filter((group) => group.id !== 'hooks').map((group) => group.id);
}

export async function scanAgentHomes(providerIds?: readonly string[]): Promise<AgentHomeScan[]> {
  const rows: AgentHomeScan[] = [];
  if (!providerIds) await ensureAgentDependenciesProbed(localDependencyManager);
  for (const plugin of pluginRegistry.getAll()) {
    const providerId = plugin.metadata.id;
    if (providerIds ? !providerIds.includes(providerId) : localDependencyManager.get(providerId as DependencyId)?.status !== 'available') continue;
    const home = homeFor(providerId);
    if (!home) continue;
    try { await prepareAutomaticImport(providerId); }
    catch (error) { if (!(error instanceof AgentHomeNotImported)) throw error; }
    const scan = await scanAgentHome(home);
    const migration = !scan.marker && !!(await upgradeProviders)?.has(providerId);
    const sourceReadable = await access(home.userConfigRoot).then(() => true, () => scan.groups.some((group) => group.count > 0));
    rows.push({
      providerId, name: plugin.metadata.name, userRoot: home.userConfigRoot, sourceReadable,
      importedAt: scan.marker?.importedAt ?? null, needsImport: !scan.marker,
      sourceUpdated: !!scan.marker && scan.newestMtime > Date.parse(scan.marker.importedAt),
      migration,
      ...(scan.marker?.migratedFrom === 'shared' ? {
        upgraded: true, upgradeSignIn: scan.marker.upgradeSignIn, terminalNeedsSignIn: scan.marker.terminalNeedsSignIn,
        oldSessionsSkipped: scan.marker.oldSessionsSkipped,
      } : {}),
      groups: scan.groups, issues: scan.issues, mcpSecrets: scan.mcpSecrets, projectMcpCount: scan.projectMcpCount,
      ...(migration ? { unmarkedMcp: scan.mcpNames } : {}),
    });
  }
  return rows;
}
const imports = new Map<string, ReturnType<typeof importHarnessHomeOnce>>();

export async function importHarnessHome(providerId: string, groups: readonly AgentHomeGroupId[], skip = false) {
  const home = homeFor(providerId);
  if (!home) throw new Error('This harness has no managed configuration root');
  const existing = imports.get(home.configRoot);
  if (existing) return existing;
  const pending = importHarnessHomeOnce(home, providerId, skip ? [] : groups, skip);
  imports.set(home.configRoot, pending);
  try { return await pending; }
  finally { imports.delete(home.configRoot); }
}

async function importHarnessHomeOnce(home: NonNullable<ReturnType<typeof homeFor>>, providerId: string, groups: readonly AgentHomeGroupId[], skip: boolean) {
  const migration = !skip && !!(await upgradeProviders)?.has(providerId);
  const historyPaths = migration && groups.length
    ? providerId === 'claude' ? ['projects', 'file-history', 'todos'] : providerId === 'codex' ? ['sessions'] : []
    : [];
  let notice: { terminalNeedsSignIn: boolean; relogin: { connectionId: string; name: string; methodId: string }[];
    upgradeSignIn?: AgentHomeMarker['upgradeSignIn'] } | undefined;
  let cleanupIssue: AgentHomeImportIssue | undefined;
  const oldSessionsSkipped = (issues: readonly AgentHomeImportIssue[]) =>
    issues.filter((issue) => issue.reason === 'tooLarge' && historyPaths.some((path) => issue.path.startsWith(`${path}/`))).length;
  const result = await importAgentHome(home, {
    skip, groups: new Set(groups), ...(migration ? { migratedFrom: 'shared' as const, historyPaths } : {}),
    beforeCommit: async (issues) => {
      if (!migration) return;
      if (providerId === 'claude' || providerId === 'codex') notice = await migrateOwnedHarnessAccounts(providerId, { ...process.env, ...loginShellEnv() }, true);
      // Existing markers are the only proof an entry belongs to Gugu. No MCP names are guessed.
      if (providerId === 'claude') cleanupIssue = await updateAgentHomeSource(home, 'settings.local.json',
        (fs, path) => stripManagedJsonHooks(fs, path, 'user'));
      if (providerId === 'codex') cleanupIssue = await updateAgentHomeSource(home, 'config.toml', async (fs, path) => {
        const original = (await fs.read(path))!;
        const stripped = stripLegacyCodexNotify(original);
        if (stripped !== original) await fs.write(path, stripped);
      });
      return { upgradeSignIn: notice?.upgradeSignIn, terminalNeedsSignIn: notice?.terminalNeedsSignIn, oldSessionsSkipped: oldSessionsSkipped(issues) };
    },
  });
  if (migration && result.marker.migratedFrom === 'shared') log.info('Imported previous harness configuration', {
    providerId, sourceRoot: home.userConfigRoot, configRoot: home.configRoot, groups: result.marker.groups,
    files: Object.keys(result.marker.files).length, skipped: result.issues.length,
  });
  const issues = cleanupIssue && !result.issues.some((item) => item.path === cleanupIssue?.path && item.reason === cleanupIssue?.reason)
    ? [...result.issues, cleanupIssue] : result.issues;
  return { issues, ...notice, oldSessionsSkipped: oldSessionsSkipped(result.issues) };
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

/** The local server CLI uses the same account process and importer as the client. */
export async function answerAgentHomeCall(payload: unknown) {
  const request = agentHomeOperationSchema.safeParse(payload);
  if (!request.success) return { error: { code: 'invalid_agent_home_command', message: 'Invalid agent home command' } };
  const operation = request.data;
  if (operation.action === 'status') {
    const { readAgentAuthStatus } = await import('@main/core/agent-config/runtime-process/host');
    const homes = await scanAgentHomes(pluginRegistry.getAll().map((plugin) => plugin.metadata.id));
    const result = await Promise.all(homes.map(async ({ providerId, userRoot, needsImport, importedAt, groups }) => {
      const auth = needsImport ? null : await readAgentAuthStatus(providerId).catch(() => null);
      return { providerId, userRoot, hasMarker: !needsImport, importedAt, groups,
        signIn: auth?.kind === 'authenticated' ? 'signed-in' : auth?.kind === 'unauthenticated' ? 'signed-out' : 'unknown' };
    }));
    return { result };
  }
  const home = homeFor(operation.providerId);
  if (!home) return { error: { code: 'unsupported_agent_home', message: 'This harness has no managed configuration root' } };
  const groups = operation.action === 'skip' ? [] : operation.groups ?? defaultAgentHomeGroups(home.importGroups);
  const result = await importHarnessHome(operation.providerId, groups, operation.action === 'skip');
  return { result: { providerId: operation.providerId, hasMarker: true, issues: result.issues } };
}

/** Skipping configuration is valid for a signed-in CLI or a Gugu model. */
export async function assertAgentHomeSignIn(providerId: string, connectionId?: string): Promise<void> {
  const home = homeFor(providerId);
  if (!home || !(await readAgentHomeMarker(home))?.skipped) return;
  const { readAgentAuthStatus } = await import('@main/core/agent-config/runtime-process/host');
  if ((await readAgentAuthStatus(providerId, connectionId))?.kind === 'unauthenticated') {
    throw new AgentHomeNotImported(providerId);
  }
}
