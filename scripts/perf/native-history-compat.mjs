import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const oldSha = 'cb2ba40311b40904aea33786008cf82e42467eeb';
function preserves(previous, next) {
  assert.equal(next.integrity, 'ok'); assert.deepEqual(next.foreignKeyErrors, []);
  const rows = new Map(next.rows.map(row => [row.id, row.sha256]));
  for (const row of previous.rows) assert.equal(rows.get(row.id), row.sha256, `Lost/changed canonical row ${row.id}`);
}

/** Every adapter operation opens the SAME disk database with its pinned real schema/initializer and closes it. */
export async function checkCompatibility(adapter, directory) {
  await mkdir(directory);
  const meta = await adapter.metadata();
  assert.equal(meta.oldSha, oldSha);
  assert.match(meta.newSha, /^[a-f0-9]{40}$/);
  assert(['source-schema', 'installed-binary'].includes(meta.level));
  assert(meta.oldInitializer && meta.newInitializer);
  const file = resolve(directory, 'roundtrip.db');
  const stages = [];
  try {
    for (const [name, action] of [
      ['old_seed', () => adapter.seedOld(file)],
      ['new_migrate_write', () => adapter.upgradeAndWriteNew(file)],
      ['old_open_write', () => adapter.openOldAndWrite(file)],
      ['new_reopen', () => adapter.reopenNew(file)],
    ]) {
      const snapshot = await action();
      const previous = stages.at(-1)?.snapshot;
      stages.push({ name, snapshot });
      await writeFile(resolve(directory, 'compat-raw.json'), JSON.stringify({ meta, stages }, null, 2));
      assert(snapshot.rows.length, 'Empty compatibility proof');
      if (previous) preserves(previous, snapshot);
      else { assert.equal(snapshot.integrity, 'ok'); assert.deepEqual(snapshot.foreignKeyErrors, []); }
    }
    assert(stages[1].snapshot.newReceiptRows > 0, 'New receipt migration/writer is not connected');
    assert(stages[2].snapshot.rows.length > stages[1].snapshot.rows.length, 'Old writer was not exercised');
    assert.equal(stages[2].snapshot.newReceiptRows, stages[1].snapshot.newReceiptRows, 'Old client damaged new receipts');
    assert.equal(stages[3].snapshot.newReceiptRows, stages[1].snapshot.newReceiptRows);
    return { passed: true, level: meta.level, meta, stages };
  } catch (error) {
    await writeFile(resolve(directory, 'compat-failed.json'), JSON.stringify({ meta, stages, error: String(error) }, null, 2));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.length === 4, 'Usage: native-history-compat.mjs ADAPTER OUTPUT');
  const result = await checkCompatibility(await import(pathToFileURL(resolve(process.argv[2])).href), resolve(process.argv[3]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
