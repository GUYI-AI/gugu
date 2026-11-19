import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { fork } from '@gugu/core/local/childProcess'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ExternalHistoryStore } from '../../../../external-import/store'

it('opens persisted history after reopening, deduplicates by owner and source, and pages the transcript', () => {
  const directory = mkdtempSync(join(tmpdir(), 'external-history-'))
  const store = new ExternalHistoryStore(directory)
  const reopened = new ExternalHistoryStore(directory)
  const conversation = {
    sourceId: 'same-source-id',
    title: 'A selected conversation',
    messages: Array.from({ length: 45 }, (_, i) => ({ role: 'user' as const, text: `Line ${i}`, at: null })),
  }
  try {
    const saved = store.import('owner-a', 'chatgpt', conversation)!
    expect(saved).toMatchObject({ title: conversation.title, projectId: null })
    store.close()
    expect(reopened.list('owner-a', 'chatgpt')).toEqual([saved])
    expect(reopened.list('owner-b', 'chatgpt')).toEqual([])
    expect(reopened.read('owner-b', saved.sessionId, 0)).toBeNull()
    const first = reopened.read('owner-a', saved.sessionId, 0)!
    expect(first.messages).toEqual(conversation.messages.slice(0, 40))
    expect(reopened.read('owner-a', saved.sessionId, first.nextOffset!)).toMatchObject({
      messages: conversation.messages.slice(40),
      nextOffset: null,
    })
    expect(reopened.import('owner-a', 'chatgpt', conversation)).toBeNull()
    expect(reopened.import('owner-a', 'cursor', conversation)?.sessionId).not.toBe(saved.sessionId)
    expect(reopened.import('owner-b', 'chatgpt', conversation)?.sessionId).not.toBe(saved.sessionId)
  } finally {
    store.close()
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  }
})


it('reads during a child write transaction and sees its commit without reopening or a memory cache', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'external-history-concurrent-'))
  const store = new ExternalHistoryStore(directory)
  const row = { sourceId: 'one', title: 'Before commit', messages: [{ role: 'user' as const, text: 'Text', at: null }] }
  const entry = store.import('owner', 'cursor', row)!
  const worker = join(directory, 'writer.cjs')
  writeFileSync(worker, `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[2]);
    db.exec('BEGIN EXCLUSIVE');
    db.prepare('UPDATE external_history SET title = ? WHERE id = ?').run('After commit', process.argv[3]);
    process.send('writing');
    process.once('message', () => { db.exec('COMMIT'); db.close(); process.send('committed', () => process.disconnect()); });
  `)
  const child = fork(worker, [join(directory, 'history.sqlite'), entry.sessionId], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const closed = once(child, 'close')
  try {
    expect(await once(child, 'message')).toEqual(['writing', undefined])
    const start = performance.now()
    expect(store.has('owner', 'cursor', 'one')).toBe(true)
    expect(store.list('owner', 'cursor')).toEqual([entry])
    expect(performance.now() - start).toBeLessThan(500)
    // Only release the writer after the synchronous reader has returned.
    const committed = once(child, 'message')
    child.send('commit')
    expect(await committed).toEqual(['committed', undefined])
    await closed
    expect(store.list('owner', 'cursor')).toEqual([{ ...entry, title: 'After commit' }])
    expect(store.has('owner', 'cursor', 'one')).toBe(true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
