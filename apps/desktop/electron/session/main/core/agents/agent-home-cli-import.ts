import { diffAgentHome, readAgentHomeMarker, reimportAgentHome } from '@gugu/session-core/agents/plugins/helpers';

/** Only an explicit CLI import may update a previous import; automatic migration stays idempotent. */
export async function reimportTerminalAgentHome(home: Parameters<typeof readAgentHomeMarker>[0], groups: readonly string[]) {
  const marker = await readAgentHomeMarker(home);
  if (!marker || marker.skipped) return null;
  const diff = await diffAgentHome(home);
  const selectedGroups = new Set(groups);
  const entries = diff.entries.filter(entry => selectedGroups.has(entry.group));
  if (entries.some(entry => entry.state === 'bothChanged')) return {
    error: { code: 'agent_home_conflict', message: 'Configuration changed in both the terminal and Gugu. Review the differences in Settings → Import before importing again.' },
  };
  const selected = entries.filter(entry => entry.state === 'userAdded' || entry.state === 'userChanged');
  // The importer rechecks these exact source/managed/baseline revisions before publishing each file.
  const result = await reimportAgentHome(home, new Set(selected.map(entry => entry.id)), new Map(selected.map(entry => [entry.id, entry.revision])));
  return { result: { providerId: home.providerId, hasMarker: true, ...result } };
}
