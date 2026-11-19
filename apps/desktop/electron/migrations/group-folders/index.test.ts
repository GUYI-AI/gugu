import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '@main/db/initialize'
import { DONE_FILE, MAPPING_FILE, runGroupFoldersOnce, SUMMARY_FILE } from './index'
import { LEGACY_PLACEHOLDER_PROJECT_ID } from '../../session/main/core/folders/legacy-project-aliases'

/**
 * Projects become folders of groups (drizzle 0054 + this data step). Seeds are what an earlier release wrote:
 * projects with root and attached folders, sessions under them, settings, remotes, automations, and the project → group
 * mapping file with its per-account file cache. Every case reads the rows back.
 */
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

async function setup(mapping: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-group-folders-'))
  const userData = path.join(root, 'userData'), guguHome = path.join(root, 'gugu')
  fs.mkdirSync(userData); fs.mkdirSync(guguHome)
  const db = new Database(path.join(root, 'gugu.db'))
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  await initializeDatabase(db)
  const project = db.prepare(`INSERT INTO projects (id, name, path, kind, gitless, base_ref, repository_workspace_id, root_folder_detached, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const workspace = db.prepare(`INSERT INTO workspaces (id, key, type, kind, location, path, project_id, attached_at) VALUES (?, ?, 'local', ?, 'local', ?, ?, ?)`)
  // api: opened, root + one attached folder; web: never opened (no root row); detached: root detached, one folder left;
  // home: the task home (kind workspace); split: bound to two groups by two accounts of this device.
  project.run('api', 'api', '/code/api', 'project', 0, 'dev', 'ws-api', 0, '2026-11-01T00:00:00Z')
  workspace.run('ws-api', 'k-api', 'project-root', '/code/api', null, null)
  workspace.run('ws-shared', 'k-shared', 'path', '/code/shared', 'api', '2026-11-02T00:00:00Z')
  project.run('web', 'web', '/code/web', 'project', 1, null, null, 0, '2026-11-03T00:00:00Z')
  project.run('detached', 'notes', '/notes', 'project', 0, null, 'ws-notes', 1, '2026-11-04T00:00:00Z')
  workspace.run('ws-notes', 'k-notes', 'project-root', '/notes', null, null)
  workspace.run('ws-notes-extra', 'k-notes-extra', 'path', '/notes-extra', 'detached', '2026-11-05T00:00:00Z')
  project.run('home', 'home', '/home/me/.gugu/task-home', 'workspace', 1, null, 'ws-home', 0, '2026-11-01T00:00:00Z')
  workspace.run('ws-home', 'k-home', 'project-root', '/home/me/.gugu/task-home', null, null)
  project.run('split', 'split', '/split', 'project', 0, null, null, 0, '2026-11-06T00:00:00Z')
  const session = db.prepare('INSERT INTO sessions (id, project_id, workspace_id, config) VALUES (?, ?, ?, ?)')
  session.run('s-api', 'api', 'ws-shared', '{}')
  session.run('s-api-old', 'api', null, '{}')
  session.run('s-web', 'web', null, '{}')
  session.run('s-home', 'home', 'ws-home', '{}')
  session.run('s-split', 'split', null, '{}')
  db.prepare(`INSERT INTO project_settings (project_id, base_project_settings_json, shareable_project_settings_json, legacy_config_migrated_at)
    VALUES ('api', '{"shell":"zsh"}', '{"x":1}', '2026-11-01T00:00:00Z')`).run()
  db.prepare(`INSERT INTO project_remotes (project_id, remote_name, remote_url) VALUES ('api', 'origin', 'git@example:api.git')`).run()
  db.prepare(`INSERT INTO automations (id, name, project_id, agent_config, session_config, trigger_config, created_at, updated_at)
    VALUES ('a1', 'nightly', 'api', '{}', '{}', '{}', 0, 0)`).run()
  if (mapping !== undefined) fs.writeFileSync(path.join(guguHome, MAPPING_FILE), JSON.stringify(mapping))
  const run = () => runGroupFoldersOnce({ db, userData, guguHome })
  return { db, userData, guguHome, run }
}

const MAPPING = {
  owners: {
    u1: { api: 'chat-api', web: 'chat-web', detached: 'chat-notes', split: 'chat-one' },
    u2: { split: 'chat-two' },
  },
  unowned: {},
  files: {
    u1: {
      'item:i1@2': { source: 'local', item_id: 'i1', version: 2, chat_id: 'chat-api', file_name: 'a.ts', content_type: 'text/plain',
        size_bytes: 1, sha256: 'ab', host_device_id: 'd1', host_project_id: 'api', host_account_id: 'u1', relative_path: 'a.ts' },
      'item:i2@1': { source: 'local', chat_id: 'chat-api', file_name: 'b.ts', content_type: 'text/plain', size_bytes: 1, sha256: 'cd',
        host_device_id: 'd1', host_project_id: 'api', host_account_id: 'u1', relative_path: 'b.ts' },
      junk: { source: 'local' },
    },
  },
}

describe('group folders data migration', () => {
  it('binds every project folder to its group, root first, and records the folder-level facts', async () => {
    const { db, run } = await setup(MAPPING)
    const summary = await run()
    const folders = db.prepare(`SELECT id, kind, path, chat_id, sort, gitless, base_ref FROM workspaces ORDER BY path`).all()
    expect(folders).toEqual(expect.arrayContaining([
      { id: 'ws-api', kind: 'project-root', path: '/code/api', chat_id: 'chat-api', sort: 1, gitless: 0, base_ref: 'dev' },
      { id: 'ws-shared', kind: 'project-root', path: '/code/shared', chat_id: 'chat-api', sort: 2, gitless: 0, base_ref: null },
      // A detached root stays a folder without a group; the folder still attached keeps the group.
      { id: 'ws-notes', kind: 'project-root', path: '/notes', chat_id: null, sort: null, gitless: 0, base_ref: null },
      { id: 'ws-notes-extra', kind: 'project-root', path: '/notes-extra', chat_id: 'chat-notes', sort: 2, gitless: 0, base_ref: null },
      // The task home is a folder without a group.
      { id: 'ws-home', kind: 'project-root', path: '/home/me/.gugu/task-home', chat_id: null, sort: null, gitless: 1, base_ref: null },
    ]))
    // A project never opened gets its root folder now.
    const web = db.prepare(`SELECT chat_id, gitless FROM workspaces WHERE path = '/code/web'`).get()
    expect(web).toEqual({ chat_id: 'chat-web', gitless: 1 })
    expect(summary).toMatchObject({ projects: 5, createdRoots: 2, ambiguous: [{ projectId: 'split', chatIds: ['chat-one', 'chat-two'] }] })
  })

  it('puts sessions in their project group, gives every session a cwd, and never guesses an ambiguous group', async () => {
    const { db, run } = await setup(MAPPING)
    await run()
    const rows = Object.fromEntries((db.prepare('SELECT id, chat_id, workspace_id FROM sessions').all() as { id: string; chat_id: string | null; workspace_id: string | null }[])
      .map((row) => [row.id, row]))
    expect(rows['s-api']).toMatchObject({ chat_id: 'chat-api', workspace_id: 'ws-shared' })
    expect(rows['s-api-old']).toMatchObject({ chat_id: 'chat-api', workspace_id: 'ws-api' })
    expect(rows['s-web']!.chat_id).toBe('chat-web')
    expect(rows['s-web']!.workspace_id).toBeTruthy()
    expect(rows['s-home']).toMatchObject({ chat_id: null, workspace_id: 'ws-home' })
    expect(rows['s-split']!.chat_id).toBeNull()
    // The activity journal's record of each session's group follows.
    expect(db.prepare(`SELECT chat_id FROM activity_session_chats WHERE session_id = 's-api'`).get()).toEqual({ chat_id: 'chat-api' })
    expect(Object.values(rows).every((row) => row.workspace_id)).toBe(true)
  })

  it('moves settings, remotes and automations to the root folder, and records every project as an alias', async () => {
    const { db, run } = await setup(MAPPING)
    await run()
    expect(db.prepare('SELECT workspace_id, base_settings_json, shareable_settings_json, legacy_config_migrated_at FROM workspace_settings').all())
      .toEqual([{ workspace_id: 'ws-api', base_settings_json: '{"shell":"zsh"}', shareable_settings_json: '{"x":1}', legacy_config_migrated_at: '2026-11-01T00:00:00Z' }])
    expect(db.prepare('SELECT workspace_id, remote_name FROM workspace_remotes').all()).toEqual([{ workspace_id: 'ws-api', remote_name: 'origin' }])
    expect(db.prepare(`SELECT workspace_id FROM automations WHERE id = 'a1'`).get()).toEqual({ workspace_id: 'ws-api' })
    expect(db.prepare(`SELECT root_workspace_id, chat_id FROM legacy_project_aliases WHERE project_id = 'detached'`).get())
      .toEqual({ root_workspace_id: 'ws-notes', chat_id: 'chat-notes' })
    expect(db.prepare('SELECT count(*) AS n FROM legacy_project_aliases').get()).toEqual({ n: 5 })
    // The previous release's NOT NULL project_id has a target.
    expect(db.prepare('SELECT kind FROM projects WHERE id = ?').get(LEGACY_PLACEHOLDER_PROJECT_ID)).toEqual({ kind: 'workspace' })
  })

  it('moves the file cache (keyed entries too), drops what names no item, and keeps the mapping file renamed', async () => {
    const { db, guguHome, userData, run } = await setup(MAPPING)
    const summary = await run()
    expect(db.prepare('SELECT account_id, item_id, version FROM file_revision_cache ORDER BY item_id').all())
      .toEqual([{ account_id: 'u1', item_id: 'i1', version: 2 }, { account_id: 'u1', item_id: 'i2', version: 1 }])
    expect(summary).toMatchObject({ cachedFileRevisions: 2, droppedFileRevisions: 1 })
    expect(fs.existsSync(path.join(guguHome, MAPPING_FILE))).toBe(false)
    expect(fs.existsSync(path.join(guguHome, `${MAPPING_FILE}.migrated-c1`))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'migrations', SUMMARY_FILE), 'utf8'))).toMatchObject({ projects: 5 })
  })

  it('runs once; a run that committed but did not finish reads the renamed mapping again and lands the same rows', async () => {
    const { db, userData, run } = await setup(MAPPING)
    await run()
    expect(await run()).toBeNull()
    const before = db.prepare('SELECT id, chat_id, sort FROM workspaces ORDER BY id').all()
    fs.rmSync(path.join(userData, 'migrations', DONE_FILE))
    await run()
    expect(db.prepare('SELECT id, chat_id, sort FROM workspaces ORDER BY id').all()).toEqual(before)
    expect(db.prepare(`SELECT chat_id FROM sessions WHERE id = 's-api'`).get()).toEqual({ chat_id: 'chat-api' })
  })

  it('without a mapping file every folder is left without a group (nothing guessed)', async () => {
    const { db, run } = await setup(undefined)
    await run()
    expect(db.prepare('SELECT count(*) AS n FROM workspaces WHERE chat_id IS NOT NULL').get()).toEqual({ n: 0 })
  })

  it('fails loudly on a mapping file it cannot read, and retries next start', async () => {
    const { guguHome, userData, run } = await setup(undefined)
    fs.writeFileSync(path.join(guguHome, MAPPING_FILE), '[1,2')
    await expect(run()).rejects.toThrow()
    expect(fs.existsSync(path.join(userData, 'migrations', DONE_FILE))).toBe(false)
  })
})
