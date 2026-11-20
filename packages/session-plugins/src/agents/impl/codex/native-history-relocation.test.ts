import { chmod, stat, mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentHome } from '@gugu/session-core/agents/plugins';
import { streamImportFile, writeAgentHomeRecord } from '@gugu/session-core/agents/plugins/helpers';
import { NATIVE_HISTORY_RECORD, nativeHistoryClosure, nativeHistoryCounts, readNativeHistoryLedger, readNativeRolloutMeta, relocateNativeCodexHistory, verifyNativeHistoryPrefix, type NativeHistoryOptions } from './native-history-relocation';
import { codexPlatformProviderConfigArgs } from './platform-provider-args';

vi.mock('@gugu/session-core/agents/plugins/helpers', async importOriginal => {
  const original = await importOriginal<typeof import('@gugu/session-core/agents/plugins/helpers')>();
  return { ...original, streamImportFile: vi.fn(original.streamImportFile) };
});

// This process speaks the real stdio protocol. Its state DB surrogate deliberately outlives files.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'), p = require('node:path'), z = require('node:zlib');
const home = process.env.CODEX_HOME, native = home === process.env.TEST_NATIVE;
const resumed = new Set();
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const scan = () => {
 const out = [];
 for (const dir of ['sessions','archived_sessions']) {
  const walk = folder => { if(!fs.existsSync(folder)) return; for(const ent of fs.readdirSync(folder,{withFileTypes:true})) {
   const path = p.join(folder,ent.name); if(ent.isDirectory()) walk(path);
   else if(/\\.jsonl(?:\\.zst)?$/.test(path)) { let bytes=fs.readFileSync(path); if(path.endsWith('.zst'))bytes=z.zstdDecompressSync(bytes); out.push({path,meta:JSON.parse(bytes.toString().split('\\n')[0]).payload}); }
  }}; walk(p.join(home,dir));
 }
 return out;
};
const indexPath = p.join(home,'.test-index.json');
let index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath)) : scan().map(f=>({id:f.meta.id,modelProvider:f.meta.model_provider,archived:f.path.includes('archived_sessions')}));
const store = () => fs.writeFileSync(indexPath,JSON.stringify(index));
store();
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(!m.id)return;
 fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({native,method:m.method,params:m.params,args:process.argv.slice(2)})+'\\n');
 try {
 let result={}; const files=scan(), thread=files.find(f=>f.meta.id===m.params?.threadId);
 if(m.method==='initialize') result={};
 else if(m.method==='thread/resume') {
  if(process.env.TEST_RESUME_FAIL==='1')throw Error('resume failed');
  if(!process.argv.some(a=>a==='model_provider=gugu_platform'))throw Error('provider missing');
  if(!thread)throw Error('thread not found');
  if(m.params.model!==thread.meta.model)throw Error('model changed');
  if(!thread.meta.source?.subagent?.thread_spawn||m.params.excludeTurns!==true)resumed.add(thread.meta.id);
  if(!thread.path.endsWith('.zst'))fs.appendFileSync(thread.path,JSON.stringify({type:'thread_settings',payload:{model:m.params.model}})+'\\n');
  result={thread:{id:thread.meta.id,path:process.env.TEST_ESCAPE_PATH||thread.path},modelProvider:thread.meta.model_provider};
 } else if(m.method==='thread/read') { if(native&&process.env.TEST_NATIVE_READ_FAIL==='1')throw Error('native history no longer readable'); if(!thread)throw Error('thread not found'); result={thread:{id:thread.meta.id,model:thread.meta.model,path:thread.path,title:thread.meta.title}}; }
 else if(m.method==='thread/turns/list') {
  if(native&&process.env.TEST_NATIVE_READ_FAIL==='1')throw Error('native history no longer readable');
  if(!thread)throw Error('thread not found'); let turns=thread.meta.turns||[];
  if(!native&&!resumed.has(thread.meta.id))turns=[];
  if(!native&&process.env.TEST_TURNS_DIFFER==='1')turns=[...turns,'extra'];
  const from=Number(m.params.cursor||0),end=from+m.params.limit;
  result={data:turns.slice(from,end).map(id=>({id})),nextCursor:end<turns.length?String(end):null};
 } else if(m.method==='thread/list') {
  if(!m.params.useStateDbOnly)throw Error('must use state db');
  if(!m.params.sourceKinds.includes('subAgentThreadSpawn'))throw Error('must list spawn sources');
  const rows=index.filter(row=>row.modelProvider==='gugu_platform'&&row.archived===m.params.archived),from=Number(m.params.cursor||0),end=from+m.params.limit;
  result={data:rows.slice(from,end),nextCursor:end<rows.length?String(end):null};
 } else if(m.method==='thread/delete') {
  if(!native)throw Error('must delete native home');
  if(process.env.TEST_DELETE_REFERENCE==='1')throw Error('forked history still references it');
  if(!thread)throw Error('no rollout found for thread id '+m.params.threadId);
  const ids=new Set([m.params.threadId]); let changed;
  do {changed=false; for(const f of files) {const parent=f.meta.source?.subagent?.thread_spawn?.parent_thread_id;if(ids.has(parent)&&!ids.has(f.meta.id)){ids.add(f.meta.id);changed=true;}}}while(changed);
  for(const f of files)if(ids.has(f.meta.id))fs.unlinkSync(f.path);
  const once=p.join(home,'.delete-once');
  if(process.env.TEST_PARTIAL_DELETE==='1'&&!fs.existsSync(once)){fs.writeFileSync(once,'1');throw Error('interrupted after file deletion');}
  index=index.filter(row=>!ids.has(row.id));store();
 }
 emit({id:m.id,result});
 } catch(error){emit({id:m.id,error:{message:error.message}})}
});
`;
const roots: string[] = [];
afterEach(async () => { vi.mocked(streamImportFile).mockClear(); vi.mocked(streamImportFile).mockReset(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-native-history-test-')); roots.push(root);
  const native = join(root, 'native'), managed = join(root, 'managed', '.codex'), cli = join(root, 'codex.cjs'), calls = join(root, 'calls.jsonl');
  await mkdir(native); await mkdir(managed, { recursive: true }); await writeFile(cli, FAKE); await chmod(cli, 0o700); await writeFile(calls, '');
  const original = await vi.importActual<typeof import('@gugu/session-core/agents/plugins/helpers')>('@gugu/session-core/agents/plugins/helpers');
  vi.mocked(streamImportFile).mockImplementation(original.streamImportFile);
  const home: ResolvedAgentHome = { providerId: 'codex', osHomeDir: root, userConfigRoot: native, configRoot: managed, shadowHome: dirname(managed), envVar: 'CODEX_HOME', importGroups: [], credentialPaths: [], carryExclusions: [], seedFiles: [] };
  const ids = new Set<string>(), env = { ...process.env, TEST_NATIVE: native, TEST_CALLS: calls };
  const options: NativeHistoryOptions = { home, ownedIds: ids, context: { cli, env }, cliVersion: 'codex-cli 0.167.2', pageSize: 1,
    resolveProvider: async () => ({ args: codexPlatformProviderConfigArgs({ providerId: 'gugu_platform', providerName: 'Gugu', baseUrl: 'http://127.0.0.1:1/v1' }), env: { OPENAI_API_KEY: 'test-not-a-key' } }) };
  const add = async (provider = 'gugu_platform', owned = true, extra: Record<string, unknown> = {}, archived = false, compressed = false) => {
    const id = randomUUID(); if (owned) ids.add(id);
    const path = join(archived ? 'archived_sessions' : 'sessions/2026/11/19', `rollout-2026-11-19T00-00-00-${id}.jsonl${compressed ? '.zst' : ''}`);
    const meta = { id, model_provider: provider, model: 'original-model', source: 'cli', turns: ['turn-1', 'turn-2'], ...extra };
    const content = Buffer.from(JSON.stringify({ type: 'session_meta', payload: meta }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { text: id } }) + '\n');
    await mkdir(dirname(join(native, path)), { recursive: true }); await writeFile(join(native, path), compressed ? zstdCompressSync(content) : content);
    return { id, path, content, meta };
  };
  return { root, native, managed, home, options, add, ids, env, calls: async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
const exists = (path: string) => access(path).then(() => true, () => false);

describe('native Codex history relocation', () => {
  it('only moves platform threads recorded in this profile and preserves the original model', async () => {
    const r = await rig(), owned = await r.add(), openai = await r.add('openai'), unowned = await r.add('gugu_platform', false), imported = await r.add('custom');
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts).toEqual({ removed: 1, retained: 0, pending: 0, unowned: 1 });
    expect(result.complete).toBe(true); expect(await exists(join(r.native, owned.path))).toBe(false);
    for (const item of [openai, unowned, imported]) expect(await readFile(join(r.native, item.path))).toEqual(item.content);
    const managed = await readFile(join(r.managed, owned.path)); expect(managed.subarray(0, owned.content.length)).toEqual(owned.content);
    expect(managed.length).toBeGreaterThan(owned.content.length);
    const calls = await r.calls(); expect(calls.filter(c => c.method === 'thread/resume')[0].params.model).toBe('original-model');
    expect(calls.filter(c => c.method === 'thread/list').every(c => c.params.useStateDbOnly && c.params.limit === 1)).toBe(true);
    expect(calls.filter(c => c.method === 'thread/list').map(c => c.params.archived)).toContain(true);
  });
  it('derives spawned descendants from metadata even when parentThreadId is null', async () => {
    const r = await rig(), root = await r.add();
    const child = await r.add('gugu_platform', false, { parentThreadId: null, source: { subagent: { thread_spawn: { parent_thread_id: root.id } } } });
    const onlyParent = await r.add('openai', false, { parent_thread_id: root.id });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.removed).toBe(1); expect(result.counts.unowned).toBe(0); expect(result.entries[root.id]!.members.sort()).toEqual([root.id, child.id].sort());
    expect(await exists(join(r.native, child.path))).toBe(false); expect(await exists(join(r.native, onlyParent.path))).toBe(true);
  });
  it('resumes every spawned member with its own model before verifying its turns', async () => {
    const r = await rig(), root = await r.add();
    const child = await r.add('gugu_platform', false, {
      model: 'child-model', turns: ['child-turn'],
      source: { subagent: { thread_spawn: { parent_thread_id: root.id } } },
    });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts).toEqual({ removed: 1, retained: 0, pending: 0, unowned: 0 });
    expect(await exists(join(r.native, root.path))).toBe(false);
    expect(await exists(join(r.native, child.path))).toBe(false);
    const calls = await r.calls();
    expect(calls.filter(call => call.method === 'thread/resume').map(call => call.params)).toEqual([
      { threadId: root.id, excludeTurns: true, model: 'original-model' },
      { threadId: child.id, excludeTurns: false, model: 'child-model' },
    ]);
    for (const member of [root, child]) {
      const resume = calls.findIndex(call => !call.native && call.method === 'thread/resume' && call.params.threadId === member.id);
      const turns = calls.findIndex(call => !call.native && call.method === 'thread/turns/list' && call.params.threadId === member.id);
      expect(resume).toBeGreaterThanOrEqual(0); expect(turns).toBeGreaterThan(resume);
      const copy = await readFile(join(r.managed, member.path));
      expect(copy.subarray(0, member.content.length)).toEqual(member.content);
    }
  });
  it('accepts app-server replies containing Unicode line separators in metadata', async () => {
    const r = await rig(); await r.add('gugu_platform', true, { title: 'before\u2028middle\u2029after' });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.removed).toBe(1); expect(result.counts.pending).toBe(0);
  });
  it('retains an entire subtree containing a non-Gugu child', async () => {
    const provider = 'openai';
    const r = await rig(), root = await r.add(); await r.add(provider, false, { source: { subagent: { thread_spawn: { parent_thread_id: root.id } } } });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.entries[root.id]).toMatchObject({ state: 'retained', reason: 'subtreeNotOwned' });
    expect(await readFile(join(r.native, root.path))).toEqual(root.content); expect(await r.calls()).toEqual([]);
  });
  it('retains roots when a rollout metadata line cannot be read', async () => {
    const r = await rig(), root = await r.add(), opaque = await r.add('gugu_platform', false);
    await writeFile(join(r.native, opaque.path), 'invalid metadata\n');
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.entries[root.id]).toMatchObject({ state: 'retained', reason: 'subtreeNotOwned' });
    expect(await exists(join(r.native, root.path))).toBe(true); expect(await r.calls()).toEqual([]);
  });
  it('retains external fork references and attached forks', async () => {
    const r = await rig(), root = await r.add(); await r.add('openai', false, { history_base: { thread_id: root.id }, attached_thread: true, forked_from_id: root.id });
    const result = await relocateNativeCodexHistory(r.options); expect(result.entries[root.id]).toMatchObject({ state: 'retained', reason: 'referenced' });
    expect(await exists(join(r.native, root.path))).toBe(true);
  });
  it.each(['ENOSPC', 'ESTALE'])('rolls back newly created outputs after %s', async code => {
    const r = await rig(), root = await r.add();
    vi.mocked(streamImportFile).mockImplementationOnce(async (_source, destination, _expected, _root, onCreated) => { await writeFile(destination!, 'partial'); await onCreated?.(await stat(destination!)); throw Object.assign(new Error(code), { code }); });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.pending).toBe(1); expect(await exists(join(r.managed, root.path))).toBe(false);
    expect(await readFile(join(r.native, root.path))).toEqual(root.content); expect((await r.calls()).some(c => c.method === 'thread/delete')).toBe(false);
  });
  it('keeps a concurrently created destination when wx loses the race', async () => {
    const r = await rig(), root = await r.add();
    vi.mocked(streamImportFile).mockImplementationOnce(async (_source, destination) => {
      await writeFile(destination!, 'created by another importer');
      throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
    });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.pending).toBe(1); expect(await readFile(join(r.managed, root.path), 'utf8')).toBe('created by another importer');
    expect(await readFile(join(r.native, root.path))).toEqual(root.content);
  });
  it('moves an existing managed copy whose original bytes are an exact prefix', async () => {
    const r = await rig(), root = await r.add(); await mkdir(dirname(join(r.managed, root.path)), { recursive: true });
    const appended = Buffer.concat([root.content, Buffer.from(JSON.stringify({ type: 'thread_settings', payload: { model: 'original-model' } }) + '\n')]);
    await writeFile(join(r.managed, root.path), appended);
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.removed).toBe(1); expect((await readFile(join(r.managed, root.path))).subarray(0, appended.length)).toEqual(appended);
  });
  it('retains a diverged managed file without overwriting either copy', async () => {
    const r = await rig(), root = await r.add(); await mkdir(dirname(join(r.managed, root.path)), { recursive: true }); await writeFile(join(r.managed, root.path), 'different');
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.entries[root.id]).toMatchObject({ state: 'retained', reason: 'managedDiverged' });
    expect(await readFile(join(r.native, root.path))).toEqual(root.content); expect(await readFile(join(r.managed, root.path), 'utf8')).toBe('different');
  });
  it.each(['TEST_RESUME_FAIL', 'TEST_TURNS_DIFFER', 'TEST_ESCAPE_PATH'])('does not delete when proof fails: %s', async key => {
    const r = await rig(), root = await r.add(); Object.assign(r.env, { [key]: key === 'TEST_ESCAPE_PATH' ? join(r.native, root.path) : '1' });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.pending).toBe(1); expect(await exists(join(r.native, root.path))).toBe(true);
    expect(await exists(join(r.managed, root.path))).toBe(false); expect((await r.calls()).some(c => c.method === 'thread/delete')).toBe(false);
  });
  it('defers old CLIs and failed probe construction without launching an app-server', async () => {
    const r = await rig(), root = await r.add();
    let result = await relocateNativeCodexHistory({ ...r.options, cliVersion: '0.166.9' });
    expect(result.entries[root.id]!.reason).toBe('codexTooOld');
    result = await relocateNativeCodexHistory({ ...r.options, resolveProvider: async () => { throw new Error('probe unavailable'); } });
    expect(result.entries[root.id]!.reason).toContain('probe unavailable'); expect(result.counts.pending).toBe(1); expect(await r.calls()).toEqual([]);
  });
  it('accepts appended managed bytes, compressed rollouts, archived files and all reverted rollouts', async () => {
    const r = await rig(), root = await r.add('gugu_platform', true, {}, true, true);
    const duplicate = join('sessions/2026/11/19', `rollout-2026-11-19T00-00-01-${randomUUID()}.jsonl`);
    await mkdir(dirname(join(r.native, duplicate)), { recursive: true }); await writeFile(join(r.native, duplicate), root.content);
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.removed).toBe(1); expect(await exists(join(r.native, duplicate))).toBe(false);
    expect(await readNativeRolloutMeta(join(r.managed, root.path))).toMatchObject({ id: root.id });
  });
  it('copies referenced prefixes without deleting them', async () => {
    const r = await rig(), prefix = await r.add('openai', false), root = await r.add('gugu_platform', true, { history_base: { thread_id: prefix.id } });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.removed).toBe(1); expect(await readFile(join(r.native, prefix.path))).toEqual(prefix.content);
    expect(await readFile(join(r.managed, prefix.path))).toEqual(prefix.content); expect(await exists(join(r.native, root.path))).toBe(false);
  });
  it('records a missing history prefix as pending before any app-server is started', async () => {
    const r = await rig(), root = await r.add('gugu_platform', true, { history_base: { thread_id: randomUUID() } });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.entries[root.id]!.state).toBe('pending'); expect(result.counts.pending).toBe(1);
    expect(await exists(join(r.native, root.path))).toBe(true); expect(await r.calls()).toEqual([]);
  });
  it('deletes an owned referencing root before the root whose prefix it uses', async () => {
    const r = await rig(), prefix = await r.add(), fork = await r.add('gugu_platform', true, { history_base: { thread_id: prefix.id } });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.removed).toBe(2);
    expect((await r.calls()).filter(call => call.method === 'thread/delete').map(call => call.params.threadId)).toEqual([fork.id, prefix.id]);
  });
  it('continues deleting without replaying native history that a prior partial delete already removed', async () => {
    const r = await rig(), root = await r.add();
    await mkdir(dirname(join(r.managed, root.path)), { recursive: true }); await writeFile(join(r.managed, root.path), root.content);
    const proof = await verifyNativeHistoryPrefix(join(r.native, root.path), join(r.managed, root.path));
    await writeAgentHomeRecord(r.home, NATIVE_HISTORY_RECORD, { version: 1, sourceRoot: r.native, complete: false, unowned: [], counts: {}, entries: { [root.id]: { state: 'deleting', model: 'original-model', members: [root.id], files: [{ path: root.path, destination: root.path, ...proof }], created: [] } } });
    Object.assign(r.env, { TEST_NATIVE_READ_FAIL: '1' });
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.counts.removed).toBe(1); expect((await r.calls()).filter(call => call.native && ['thread/read', 'thread/turns/list'].includes(call.method))).toEqual([]);
  });
  it('does not claim removal while state rows remain after an interrupted delete', async () => {
    const r = await rig(), root = await r.add(); Object.assign(r.env, { TEST_PARTIAL_DELETE: '1' });
    const first = await relocateNativeCodexHistory(r.options); expect(first.counts.pending).toBe(1); expect(first.entries[root.id]!.state).toBe('deleting');
    // A repeated no-rollout response cannot hide a remaining sidebar row.
    const second = await relocateNativeCodexHistory(r.options); expect(second.counts.removed).toBe(0); expect(second.counts.pending).toBe(1);
    await writeFile(join(r.native, '.test-index.json'), '[]');
    const third = await relocateNativeCodexHistory(r.options); expect(third.counts.removed).toBe(1); expect(third.complete).toBe(true);
  });
  it('rechecks a deleting record and refuses a source changed since the last proof', async () => {
    const r = await rig(), root = await r.add();
    await mkdir(dirname(join(r.managed, root.path)), { recursive: true }); await writeFile(join(r.managed, root.path), root.content);
    await writeAgentHomeRecord(r.home, NATIVE_HISTORY_RECORD, { version: 1, sourceRoot: r.native, complete: false, unowned: [], counts: {}, entries: { [root.id]: { state: 'deleting', model: 'original-model', members: [root.id], files: [{ path: root.path, destination: root.path }], created: [] } } });
    await writeFile(join(r.native, root.path), Buffer.concat([root.content, Buffer.from('changed\n')]));
    const result = await relocateNativeCodexHistory(r.options);
    expect(result.entries[root.id]!.state).toBe('deleting'); expect(result.counts.removed).toBe(0); expect((await r.calls()).some(c => c.method === 'thread/delete')).toBe(false);
  });
  it('trusts completed ledgers without scanning or launching again', async () => {
    const r = await rig(); await r.add(); const first = await relocateNativeCodexHistory(r.options), calls = await r.calls();
    expect(await relocateNativeCodexHistory(r.options)).toEqual(first); expect(await r.calls()).toEqual(calls);
    expect((await readNativeHistoryLedger(r.home))?.counts).toEqual(nativeHistoryCounts(first));
  });
  it.each(['same', 'nested'])('refuses overlapping source and managed homes: %s', async placement => {
    const r = await rig(), root = await r.add();
    const configRoot = placement === 'same' ? r.native : join(r.native, 'managed');
    await mkdir(configRoot, { recursive: true });
    await expect(relocateNativeCodexHistory({ ...r.options, home: { ...r.home, configRoot } })).rejects.toThrow('homes overlap');
    expect(await readFile(join(r.native, root.path))).toEqual(root.content); expect(await r.calls()).toEqual([]);
  });
  it('rejects symlinked rollout directories', async () => {
    const r = await rig(); const { symlink } = await import('node:fs/promises'); await symlink(r.managed, join(r.native, 'sessions'));
    await expect(relocateNativeCodexHistory(r.options)).rejects.toThrow('symbolic link');
  });
});

it('compares decompressed source bytes against the destination prefix', async () => {
  const r = await rig(), source = join(r.root, 'source.jsonl.zst'), target = join(r.root, 'target.jsonl');
  await writeFile(source, zstdCompressSync(Buffer.from('original\n'))); await writeFile(target, 'original\nappended\n');
  expect((await verifyNativeHistoryPrefix(source, target)).bytes).toBe(9);
  await writeFile(target, 'different\n'); await expect(verifyNativeHistoryPrefix(source, target)).rejects.toThrow('differs');
});

it('closure includes every meta.id rollout and recursive history_base prefix', () => {
  const root = randomUUID(), prefix = randomUUID(), prefix2 = randomUUID();
  const files = [{ path: 'a', rolloutId: root, meta: { id: root, history_base: { thread_id: prefix } } }, { path: 'b', rolloutId: prefix, meta: { id: 'another', history_base: { thread_id: prefix2 } } }, { path: 'c', rolloutId: prefix2, meta: { id: 'third' } }];
  expect(nativeHistoryClosure(root, files).files).toEqual(files);
});
