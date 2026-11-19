import { prepareManagedCodexHistory as prepareCodexHistoryAtHome } from './managed-codex-history';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { eq } from 'drizzle-orm';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import type { AgentHomeGroupId } from '@gugu/session-core/agents/plugins';
import {
  AGENT_HISTORY_LIMIT, AgentHomeMigrationFailure, AgentHomeSpaceError, planAgentHomeHistory, readAgentHomePending, checkAgentHomeImportSpace, diffAgentHome, importAgentHome, readAgentHomeMarker, reimportAgentHome, resolveAgentHome,
  scanAgentHome, updateAgentHomeSource, type AgentHomeImportIssue, type AgentHomeMarker,
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
import { appScope } from '@main/app/app-scope';
import { migrateQwenUpgradeSignIn } from './qwen-upgrade-sign-in';
import { reportAgentHomeMigrationFailure } from '../../../../error-summary-reporting-host';

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

const upgradeState = new KV<{ providers: string[]; inventory: Record<string, boolean> }>('agent-home-upgrade');
let upgradeProfile: boolean | undefined;
let upgradeStartedAt = 0;
let upgradePlan: Promise<ReadonlySet<string>> | undefined;
let inventoryComplete = false;
const automaticAttempts = new Map<string, Promise<void>>();
let spaceAdmission: Promise<void> | undefined;
let migrationSpace: AgentHomeScan['migrationSpace'];
const migrationAbort = new AbortController();
appScope.add(() => migrationAbort.abort(new Error('Application is closing')));
const migrationPreparation = new Map<string, NonNullable<AgentHomeScan['migrationPreparation']>>();
const historyPlans = new Map<string, ReturnType<typeof planAgentHomeHistory>>();
function historyPlan(home: NonNullable<ReturnType<typeof homeFor>>) {
  let plan = historyPlans.get(home.configRoot);
  if (!plan) { plan = planAgentHomeHistory(home); historyPlans.set(home.configRoot, plan); }
  return plan;
}
async function prepareManagedCodexHistory(home: NonNullable<ReturnType<typeof homeFor>>) {
  migrationPreparation.set(home.providerId, { phase: 'history', startedAt: Date.now(), attempt: 1 });
  await prepareCodexHistoryAtHome(home, migrationAbort.signal, (progress) => {
    if (progress) migrationPreparation.set(home.providerId, { phase: 'history', startedAt: progress.startedAt, attempt: progress.attempt });
  });
  migrationAbort.signal.throwIfAborted();
}
function admitAutomaticImports(providers: ReadonlySet<string>): Promise<void> {
  spaceAdmission ??= (async () => {
    const entries = [];
    for (const providerId of providers) {
      const home = homeFor(providerId);
      if (home && !await readAgentHomeMarker(home) && !await readAgentHomePending(home)) entries.push({
        home, groups: new Set(defaultAgentHomeGroups(home.importGroups)), historyPaths: (await historyPlan(home)).paths,
      });
    }
    await checkAgentHomeImportSpace(entries);
  })().catch((error: unknown) => {
    if (error instanceof AgentHomeSpaceError) migrationSpace = error.space;
    throw error;
  });
  return spaceAdmission;
}

async function planUpgrade(priorProfile: boolean): Promise<ReadonlySet<string>> {
  const previous = await upgradeState.get('providers');
  const inventory = {
    ...await upgradeState.get('inventory'),
    ...Object.fromEntries((previous ?? []).map((providerId) => [providerId, true])),
  };
  // A profile originally created by Gugu can still predate a newly managed engine.
  const existingProfile = priorProfile || Boolean(previous) || Object.keys(inventory).length > 0;
  const unknown = pluginRegistry.getAll().filter((plugin) =>
    plugin.capabilities.sessionBundle?.configRoot && !Object.hasOwn(inventory, plugin.metadata.id));
  const observed = existingProfile && unknown.length > 0 && await ensureAgentDependenciesProbed(localDependencyManager)
    .then(() => true, () => { log.warn('Could not finish the harness inventory for configuration upgrade'); return false; });
  const changed: Record<string, boolean> = {};
  for (const { metadata: { id } } of unknown) {
    const status = localDependencyManager.get(id as DependencyId)?.status;
    if (hasOldTasks(id) || (existingProfile && status === 'available')) changed[id] = true;
    else if (!existingProfile || observed && status === 'missing') changed[id] = false;
  }
  if (Object.keys(changed).length) await upgradeState.setOrThrow('inventory', { ...inventory, ...changed });
  inventoryComplete = unknown.every(({ metadata: { id } }) => Object.hasOwn(changed, id));
  return new Set(Object.entries({ ...inventory, ...changed }).filter(([, installed]) => installed).map(([id]) => id));
}

function upgradeProviders(): Promise<ReadonlySet<string>> | undefined {
  if (upgradeProfile === undefined) return;
  upgradePlan ??= planUpgrade(upgradeProfile).finally(() => {
    if (!inventoryComplete) upgradePlan = undefined;
  });
  return upgradePlan;
}

export function initializeAgentHomeUpgrade(priorProfile: boolean): void {
  if (upgradeProfile !== undefined) return;
  upgradeProfile = priorProfile;
  upgradeStartedAt = Date.now();
  setAgentHomeUpgradePreparation(prepareAutomaticImport);
  void upgradeProviders()?.then((ids) => Promise.allSettled([...ids].map(prepareAutomaticImport))).catch((error: unknown) => {
    log.error('Could not plan the managed configuration upgrade');
    reportAgentHomeMigrationFailure(error, 'inventory');
  });
}

async function prepareAutomaticImport(providerId: string): Promise<void> {
  const providers = await upgradeProviders()?.catch((error: unknown) => {
    reportAgentHomeMigrationFailure(error, 'inventory');
    return undefined;
  });
  if (!providers?.has(providerId)) return;
  let pending = automaticAttempts.get(providerId);
  if (!pending) {
    migrationPreparation.set(providerId, { phase: 'preparing', startedAt: Date.now(), attempt: 1 });
    pending = (async () => {
      const home = homeFor(providerId);
      if (!home || await readAgentHomeMarker(home)) return;
      migrationPreparation.set(providerId, { phase: 'copying', startedAt: Date.now(), attempt: 1 });
      await admitAutomaticImports(providers);
      await importHarnessHome(providerId, defaultAgentHomeGroups(home.importGroups));
    })().catch(async (error: unknown) => {
      if (migrationAbort.signal.aborted) return;
      const cause = error instanceof AgentHomeMigrationFailure ? error.cause : error;
      if (cause instanceof AgentHomeSpaceError) { migrationSpace = cause.space; log.info('Deferred configuration migration until disk space is available'); return; }
      if ((cause as NodeJS.ErrnoException)?.code === 'ENOSPC') {
        spaceAdmission = undefined;
        await admitAutomaticImports(providers).catch(() => undefined);
      }
      log.error('Automatic harness configuration import failed', { providerId, error: error instanceof Error ? error.name : typeof error });
      reportAgentHomeMigrationFailure(error instanceof AgentHomeMigrationFailure ? error.cause : error,
        error instanceof AgentHomeMigrationFailure ? error.stage : 'marker');
    }).finally(() => migrationPreparation.delete(providerId));
    automaticAttempts.set(providerId, pending);
  }
  await pending;
}

export function defaultAgentHomeGroups(groups: readonly { id: AgentHomeGroupId }[]): AgentHomeGroupId[] {
  return groups.filter((group) => group.id !== 'hooks').map((group) => group.id);
}

export async function scanAgentHomes(providerIds?: readonly string[], upgradedOnly = false): Promise<AgentHomeScan[]> {
  const rows: AgentHomeScan[] = [];
  if (!providerIds && !upgradedOnly) await ensureAgentDependenciesProbed(localDependencyManager);
  for (const plugin of pluginRegistry.getAll()) {
    const providerId = plugin.metadata.id;
    if (providerIds && !providerIds.includes(providerId)) continue;
    if (!providerIds && !upgradedOnly && localDependencyManager.get(providerId as DependencyId)?.status !== 'available') continue;
    const home = homeFor(providerId);
    if (!home) continue;
    // Reads observe migration state without starting or waiting for the copy/index job.
    const planned = upgradedOnly && upgradeProfile !== undefined ? (await upgradeProviders())?.has(providerId) : false;
    const preparation = migrationPreparation.get(providerId) ?? (planned && !automaticAttempts.has(providerId)
      ? { phase: 'preparing' as const, startedAt: upgradeStartedAt, attempt: 1 } : undefined);
    if (preparation && !await readAgentHomeMarker(home)) {
      rows.push({ providerId, name: plugin.metadata.name, userRoot: home.userConfigRoot, sourceReadable: await access(home.userConfigRoot).then(() => true, () => false),
        importedAt: null, needsImport: true, sourceUpdated: false, migration: true, migrationPreparation: preparation,
        groups: [], issues: [], mcpSecrets: [], projectMcpCount: 0 });
      continue;
    }
    const deferred = migrationSpace && (await upgradeProviders())?.has(providerId) && !await readAgentHomeMarker(home);
    if (deferred) {
      rows.push({ providerId, name: plugin.metadata.name, userRoot: home.userConfigRoot,
        sourceReadable: await access(home.userConfigRoot).then(() => true, () => false), importedAt: null, needsImport: true, sourceUpdated: false, migration: true,
        migrationSpace, groups: home.importGroups.map(({ id }) => ({ id, count: 0 })), issues: [], mcpSecrets: [], projectMcpCount: 0 });
      continue;
    }
    if (upgradedOnly) {
      // A provider with a failed or invalid import record cannot hide the other results.
      const marker = await readAgentHomeMarker(home).catch(() => null);
      if (marker?.migratedFrom !== 'shared') continue;
    }
    const scan = await scanAgentHome(home);
    const migration = !scan.marker && !!(await upgradeProviders())?.has(providerId);
    const sourceReadable = await access(home.userConfigRoot).then(() => true, () => scan.groups.some((group) => group.count > 0));
    rows.push({
      providerId, name: plugin.metadata.name, userRoot: home.userConfigRoot, sourceReadable,
      importedAt: scan.marker?.importedAt ?? null, needsImport: !scan.marker,
      sourceUpdated: !!scan.marker && scan.newestMtime > Date.parse(scan.marker.importedAt),
      migration,
      ...(scan.marker?.migratedFrom === 'shared' ? {
        upgraded: true, upgradeSignIn: scan.marker.upgradeSignIn, terminalNeedsSignIn: scan.marker.terminalNeedsSignIn,
        oldSessionsSkipped: scan.marker.oldSessionsSkipped, upgradeIssues: scan.marker.upgradeIssues, historyImport: scan.marker.historyImport,
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
  const migration = !skip && !!(await upgradeProviders())?.has(providerId);
  const pending = migration && providerId === 'codex' ? await readAgentHomePending(home) : null;
  const plan = migration && groups.length && !pending ? await historyPlan(home) : undefined;
  const historyPaths = plan?.paths ?? [];
  const selectedSessionIds = new Set(historyPaths.flatMap((path) => {
    const session = home.historySession?.(path); return session?.primary ? [session.id] : [];
  }));
  const failedSessions = (issues: readonly AgentHomeImportIssue[]) => new Set(issues.flatMap((issue) => {
    const id = home.historySession?.(issue.path)?.id;
    return id && historyPaths.includes(issue.path) && selectedSessionIds.has(id) ? [id] : [];
  })).size;
  const historyIssues: AgentHomeImportIssue[] = plan ? [...plan.issues, ...plan.skipped.map(({ path }) => ({ path, reason: 'historyLimit' as const }))] : [];
  let notice: { terminalNeedsSignIn: boolean; relogin: { connectionId: string; name: string; methodId: string }[];
    upgradeSignIn?: AgentHomeMarker['upgradeSignIn'] } | undefined;
  const cleanupIssues: AgentHomeImportIssue[] = [];
  if (migration && !pending && !(await readAgentHomeMarker(home))) {
    await checkAgentHomeImportSpace([{ home, groups: new Set(groups), historyPaths }]);
    for (const { path, update } of home.legacyCleanup ?? []) {
      const issue = await updateAgentHomeSource(home, path, update);
      if (issue) cleanupIssues.push(issue);
    }
  }
  const oldSessionsSkipped = (issues: readonly AgentHomeImportIssue[]) =>
    issues.filter((issue) => issue.reason === 'historyLimit').length;
  const result = await importAgentHome(home, {
    skip, groups: new Set(groups), ...(migration ? { migratedFrom: 'shared' as const, historyPaths, historyIssues } : {}),
    ...(migration && providerId === 'codex' && groups.length ? { prepareAfterPublish: () => prepareManagedCodexHistory(home) } : {}),
    ...(migration ? {
      upgradeSummary: (issues: readonly AgentHomeImportIssue[]) => ({
        oldSessionsSkipped: oldSessionsSkipped(issues),
        ...(plan ? { historyImport: { imported: plan.sessions - failedSessions(issues), skipped: plan.skipped.length + failedSessions(issues), sessionBytes: plan.sessionBytes, limitBytes: AGENT_HISTORY_LIMIT } } : pending?.historyImport ? { historyImport: pending.historyImport } : {}),
        upgradeIssues: [...issues, ...cleanupIssues],
      }),
      afterCommit: async () => {
        if (providerId === 'qwen') {
          const upgradeSignIn = await migrateQwenUpgradeSignIn(home.userConfigRoot, home.configRoot)
            .catch((error: unknown) => {
              log.warn('Could not transfer the previous Qwen sign-in during upgrade', { providerId });
              reportAgentHomeMigrationFailure(error, 'sign-in');
              return 'relogin' as const;
            });
          return upgradeSignIn ? { upgradeSignIn } : undefined;
        }
        if (providerId !== 'claude' && providerId !== 'codex') return;
        notice = await migrateOwnedHarnessAccounts(providerId, { ...process.env, ...loginShellEnv() }, true);
        return { upgradeSignIn: notice.upgradeSignIn, terminalNeedsSignIn: notice.terminalNeedsSignIn };
      },
    } : {}),
  });
  if (migration && result.marker.migratedFrom === 'shared') log.info('Imported previous harness configuration', {
    providerId, sourceRoot: home.userConfigRoot, configRoot: home.configRoot, groups: result.marker.groups,
    files: Object.keys(result.marker.files).length, skipped: result.issues.length,
  });
  const issues = [...result.issues, ...cleanupIssues.filter((issue) =>
    !result.issues.some((item) => item.path === issue.path && item.reason === issue.reason))];
  return { issues, ...notice, oldSessionsSkipped: oldSessionsSkipped(result.issues), historyImport: result.marker.historyImport };
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
