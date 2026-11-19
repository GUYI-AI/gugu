import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { readCursorHistory } from '../../../../external-import/cursor'

it.each(['node:sqlite', 'better-sqlite3'] as const)('hydrates a Cursor Composer conversation without changing the source (%s)', async (sqliteDriver) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-history-'))
  vi.stubEnv('CURSOR_STORE_ROOT', join(root, 'store'))
  try {
    const globalStorage = join(root, 'User', 'globalStorage')
    const workspaceStorage = join(root, 'User', 'workspaceStorage')
    await mkdir(globalStorage, { recursive: true })
    await mkdir(workspaceStorage, { recursive: true })
    const path = join(globalStorage, 'state.vscdb')
    const source = new DatabaseSync(path)
    const sourceId = '00000000-0016-4016-8016-000000000016'
    try {
      source.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
      const add = source.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
      const start = 1705363200000
      add.run(`composerData:${sourceId}`, JSON.stringify({
        composerId: sourceId,
        name: 'A Cursor conversation',
        createdAt: start,
        lastUpdatedAt: start + 2000,
        workspaceIdentifier: { uri: { fsPath: join(root, 'project') } },
        fullConversationHeadersOnly: [{ bubbleId: 'user' }, { bubbleId: 'assistant' }],
      }))
      add.run(`bubbleId:${sourceId}:user`, JSON.stringify({
        type: 1, bubbleId: 'user', createdAt: new Date(start).toISOString(), text: 'A question',
      }))
      add.run(`bubbleId:${sourceId}:assistant`, JSON.stringify({
        type: 2, bubbleId: 'assistant', createdAt: new Date(start + 1000).toISOString(), text: 'A reply',
      }))
    } finally {
      source.close()
    }
    const before = await readFile(path)
    const { rows } = await readCursorHistory(new AbortController().signal, { dataPath: workspaceStorage, sqliteDriver })
    expect(rows).toEqual([{
      sourceId,
      title: 'A Cursor conversation',
      messages: [
        { role: 'user', text: 'A question', at: 1705363200000 },
        { role: 'assistant', text: 'A reply', at: 1705363201000 },
      ],
    }])
    expect(await readFile(path)).toEqual(before)
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
