import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import type { ResolvedAgentHome } from '../capabilities/config-root';
import type { AgentHomeImportIssue } from './agent-home-import';

const disk: typeof fs = process.versions.electron
  ? (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).promises : fs;
export const AGENT_HISTORY_LIMIT = 4 * 1024 ** 3;
export type AgentHomeHistoryPlan = {
  paths: string[];
  sessions: number;
  bytes: number;
  sessionBytes: number;
  skipped: { id: string; path: string; bytes: number }[];
  issues: AgentHomeImportIssue[];
};
type File = { path: string; bytes: number; active: number; session?: { id: string; primary: boolean } };

/** A session is indivisible: primary transcript plus its declared auxiliary files. */
export async function planAgentHomeHistory(home: ResolvedAgentHome, limit = AGENT_HISTORY_LIMIT): Promise<AgentHomeHistoryPlan> {
  if (home.upgradeHistory?.length && !home.historySession) throw new Error('History migration requires a declared session classifier');
  const files: File[] = [], issues: AgentHomeImportIssue[] = [];
  const root = await disk.realpath(home.userConfigRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return home.userConfigRoot;
    throw error;
  });
  const visit = async (path: string): Promise<void> => {
    if (isAbsolute(path) || path.split(/[/\\]/).includes('..')) throw new Error('Invalid history path');
    try {
      const entry = await disk.lstat(join(root, path));
      if (entry.isDirectory()) {
        for (const name of (await disk.readdir(join(root, path))).sort()) await visit(`${path}/${name}`);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const session = home.historySession?.(path);
        files.push({ path, bytes: entry.size, active: entry.mtimeMs, ...(session ? { session } : {}) });
      } else issues.push({ path, reason: 'unreadable' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({ path, reason: 'unreadable' });
    }
  };
  for (const path of home.upgradeHistory ?? []) await visit(path.replace(/\/$/, ''));
  const sessions = new Map<string, { id: string; path: string; files: File[]; bytes: number; active: number }>();
  for (const file of files) if (file.session?.primary && !sessions.has(file.session.id)) {
    sessions.set(file.session.id, { id: file.session.id, path: file.path, files: [], bytes: 0, active: 0 });
  }
  const shared: File[] = [];
  for (const file of files) {
    const session = file.session && sessions.get(file.session.id);
    if (!session) { shared.push(file); continue; }
    session.files.push(file); session.bytes += file.bytes; session.active = Math.max(session.active, file.active);
  }
  const ordered = [...sessions.values()].sort((a, b) => b.active - a.active || a.id.localeCompare(b.id));
  const chosen: File[] = [...shared];
  const result: AgentHomeHistoryPlan = { paths: [], sessions: 0, bytes: 0, sessionBytes: 0, skipped: [], issues };
  let sessionBytes = 0, full = false;
  for (const [index, session] of ordered.entries()) {
    if (!full && (sessionBytes + session.bytes <= limit || index === 0)) {
      chosen.push(...session.files); sessionBytes += session.bytes; result.sessions++;
    } else { full = true; result.skipped.push({ id: session.id, path: session.path, bytes: session.bytes }); }
  }
  result.sessionBytes = sessionBytes;
  result.paths = chosen.map(file => file.path);
  result.bytes = chosen.reduce((sum, file) => sum + file.bytes, 0);
  return result;
}
