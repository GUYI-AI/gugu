// Projects become folders of groups (@@@group-folders), the data half; the schema half is drizzle/0054_group_folders.
//
// One transaction over the session database, run once after the schema step and before any reader:
//   · every project's root folder (created when the project was never opened) and attached folders become folders bound
//     to the project's group — from <GUGU_HOME>/taskpage-project-groups.json, the only record of that binding — with
//     the root first; a detached root stays a folder without a group; gitless/base_ref move onto the root folder;
//   · sessions take the group of their project (the task home's and app-kept directories' sessions have none);
//   · project_settings / project_remotes / automations.project_id move to the root folder (workspace id);
//   · legacy_project_aliases records every project (id → root folder, group) for ids written outside this database;
//   · the mapping's per-account `files` cache moves into file_revision_cache;
//   · a placeholder project row lets new sessions satisfy the previous release's NOT NULL project_id after a rollback.
// Then the mapping file is renamed `.migrated-c1` (kept for a rollback) and `<userData>/migrations/group-folders-v1.done`
// is written with a summary. A project bound to different groups by different accounts of this device is left without a
// group and listed in the summary (fail visibly, never guess). Anything unreadable fails the run loudly; it retries on
// the next start. Delete this directory when the oldest release that can upgrade directly has run it.
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { resolveGuguHome } from '@gugu/core'
import { computeWorkspaceKey } from '../../session/main/core/workspaces/workspace-key'

export const DONE_FILE = 'group-folders-v1.done'
export const SUMMARY_FILE = 'group-folders-v1.summary.json'
export const MAPPING_FILE = 'taskpage-project-groups.json'
/** The previous release requires sessions.project_id (NOT NULL, FK): new sessions point here until it is dropped. */
export const LEGACY_PLACEHOLDER_PROJECT_ID = 'c1-placeholder'

export interface GroupFoldersDeps {
  db: Database.Database
  userData: string
  guguHome?: string
}

export interface GroupFoldersSummary {
  projects: number
  folders: number
  createdRoots: number
  sessionsInGroups: number
  sessionsWithoutGroup: number
  ambiguous: Array<{ projectId: string; chatIds: string[] }>
  cachedFileRevisions: number
  droppedFileRevisions: number
}

type Mapping = { owners: Record<string, Record<string, string>>; unowned: Record<string, string>;
  files: Record<string, Record<string, unknown>> }

async function readMapping(guguHome: string): Promise<Mapping | null> {
  // A run that committed but died before writing .done already renamed the file: read the renamed copy again.
  const file = [join(guguHome, MAPPING_FILE), join(guguHome, `${MAPPING_FILE}.migrated-c1`)].find((f) => existsSync(f))
  if (!file) return null
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${MAPPING_FILE} is not an object`)
  const raw = parsed as Record<string, unknown>
  const map = (value: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) if (k && typeof v === 'string' && v) out[k] = v
    }
    return out
  }
  const owners: Record<string, Record<string, string>> = {}
  if (raw.owners && typeof raw.owners === 'object') {
    for (const [owner, value] of Object.entries(raw.owners as Record<string, unknown>)) owners[owner] = map(value)
  } else {
    // v1: a flat project → chat map that no account claimed yet.
    return { owners: {}, unowned: map(raw), files: {} }
  }
  const files = (raw.files && typeof raw.files === 'object' ? raw.files : {}) as Record<string, Record<string, unknown>>
  return { owners, unowned: map(raw.unowned), files }
}

/** Each project's group: one chat id across every account and the unclaimed entries, or ambiguous. */
function groupsOf(mapping: Mapping | null): { chat: Map<string, string>; ambiguous: Map<string, string[]> } {
  const seen = new Map<string, Set<string>>()
  const add = (project: string, chat: string) => (seen.get(project) ?? seen.set(project, new Set()).get(project)!).add(chat)
  if (mapping) {
    for (const map of Object.values(mapping.owners)) for (const [p, c] of Object.entries(map)) add(p, c)
    for (const [p, c] of Object.entries(mapping.unowned)) add(p, c)
  }
  const chat = new Map<string, string>(), ambiguous = new Map<string, string[]>()
  for (const [project, chats] of seen) {
    if (chats.size === 1) chat.set(project, [...chats][0]!)
    else ambiguous.set(project, [...chats].sort())
  }
  return { chat, ambiguous }
}

export async function runGroupFoldersOnce(deps: GroupFoldersDeps): Promise<GroupFoldersSummary | null> {
  const dir = join(deps.userData, 'migrations')
  if (existsSync(join(dir, DONE_FILE))) return null
  const guguHome = deps.guguHome ?? resolveGuguHome(process.env)
  const mapping = await readMapping(guguHome)
  const { chat, ambiguous } = groupsOf(mapping)
  const db = deps.db
  const summary: GroupFoldersSummary = { projects: 0, folders: 0, createdRoots: 0, sessionsInGroups: 0, sessionsWithoutGroup: 0,
    ambiguous: [...ambiguous].map(([projectId, chatIds]) => ({ projectId, chatIds })), cachedFileRevisions: 0, droppedFileRevisions: 0 }

  db.transaction(() => {
    type ProjectRow = { id: string; path: string; kind: string; gitless: number; base_ref: string | null;
      repository_workspace_id: string | null; root_folder_detached: number; created_at: string }
    const projects = db.prepare(`SELECT id, path, kind, gitless, base_ref, repository_workspace_id, root_folder_detached, created_at
      FROM projects WHERE id <> ?`).all(LEGACY_PLACEHOLDER_PROJECT_ID) as ProjectRow[]
    const workspaceExists = db.prepare('SELECT 1 FROM workspaces WHERE id = ?')
    const byKey = db.prepare('SELECT id FROM workspaces WHERE key = ?')
    for (const project of projects) {
      summary.projects += 1
      // A user-visible project has its group; the task home and app-kept directories have none.
      const group = project.kind === 'project' ? chat.get(project.id) ?? null : null
      let root = project.repository_workspace_id && workspaceExists.get(project.repository_workspace_id)
        ? project.repository_workspace_id : null
      if (!root) {
        const key = computeWorkspaceKey(project.path)
        const existing = byKey.get(key) as { id: string } | undefined
        root = existing?.id ?? project.repository_workspace_id ?? randomUUID()
        if (!existing) {
          db.prepare(`INSERT INTO workspaces (id, key, type, kind, location, path) VALUES (?, ?, 'local', 'project-root', 'local', ?)`)
            .run(root, key, project.path)
          summary.createdRoots += 1
        }
      }
      const rootGroup = project.root_folder_detached ? null : group
      db.prepare(`UPDATE workspaces SET kind = 'project-root', chat_id = ?, sort = CASE WHEN ? IS NULL THEN NULL ELSE 1 END,
        gitless = ?, base_ref = ?, attached_at = CASE WHEN ? IS NULL THEN NULL ELSE ? END WHERE id = ?`)
        .run(rootGroup, rootGroup, project.gitless, project.base_ref, rootGroup, project.created_at, root)
      summary.folders += 1
      const attached = db.prepare(`SELECT id FROM workspaces WHERE project_id = ? AND id <> ? ORDER BY attached_at, id`)
        .all(project.id, root) as { id: string }[]
      attached.forEach((row, index) => {
        db.prepare(`UPDATE workspaces SET kind = 'project-root', chat_id = ?, sort = ? WHERE id = ?`)
          .run(group, group === null ? null : index + 2, row.id)
        summary.folders += 1
      })
      const sessions = db.prepare('UPDATE sessions SET chat_id = ? WHERE project_id = ?').run(group, project.id).changes
      if (group === null) summary.sessionsWithoutGroup += sessions
      else summary.sessionsInGroups += sessions
      db.prepare('UPDATE automations SET workspace_id = ? WHERE project_id = ? AND workspace_id IS NULL').run(root, project.id)
      db.prepare(`INSERT OR IGNORE INTO workspace_settings (workspace_id, base_settings_json, shareable_settings_json, created_at, updated_at)
        SELECT ?, base_project_settings_json, shareable_project_settings_json, created_at, updated_at FROM project_settings WHERE project_id = ?`)
        .run(root, project.id)
      db.prepare(`INSERT OR IGNORE INTO workspace_remotes (workspace_id, remote_name, remote_url)
        SELECT ?, remote_name, remote_url FROM project_remotes WHERE project_id = ?`).run(root, project.id)
      db.prepare('INSERT OR REPLACE INTO legacy_project_aliases (project_id, root_workspace_id, chat_id) VALUES (?, ?, ?)')
        .run(project.id, root, group)
    }
    // Ambiguous bindings: no group rather than a guess (listed in the summary).
    for (const projectId of ambiguous.keys()) db.prepare('UPDATE sessions SET chat_id = NULL WHERE project_id = ?').run(projectId)
    if (mapping) {
      const insert = db.prepare('INSERT OR REPLACE INTO file_revision_cache (account_id, item_id, version, revision_json) VALUES (?, ?, ?, ?)')
      for (const [account, entries] of Object.entries(mapping.files)) {
        for (const [key, revision] of Object.entries(entries ?? {})) {
          // The cache's key is fileRefKey: `item:<id>@<version>`. An entry neither names is dropped (counted): it is a
          // cache of immutable database records, read again on demand.
          const r = (revision ?? {}) as { item_id?: unknown; version?: unknown }
          const fromKey = /^item:(.+)@([1-9][0-9]*)$/.exec(key)
          const item = typeof r.item_id === 'string' ? r.item_id : fromKey?.[1]
          const version = Number.isSafeInteger(r.version) ? (r.version as number) : fromKey ? Number(fromKey[2]) : NaN
          if (!item || !Number.isSafeInteger(version)) { summary.droppedFileRevisions += 1; continue }
          insert.run(account, item, version, JSON.stringify(revision))
          summary.cachedFileRevisions += 1
        }
      }
    }
    db.prepare(`INSERT OR IGNORE INTO projects (id, name, path, workspace_provider, kind) VALUES (?, '', ?, 'local', 'workspace')`)
      .run(LEGACY_PLACEHOLDER_PROJECT_ID, `/.gugu-c1-placeholder-${LEGACY_PLACEHOLDER_PROJECT_ID}`)
  })()

  if (existsSync(join(guguHome, MAPPING_FILE))) await rename(join(guguHome, MAPPING_FILE), join(guguHome, `${MAPPING_FILE}.migrated-c1`))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, SUMMARY_FILE), JSON.stringify(summary, null, 2))
  await writeFile(join(dir, DONE_FILE), new Date().toISOString())
  return summary
}
