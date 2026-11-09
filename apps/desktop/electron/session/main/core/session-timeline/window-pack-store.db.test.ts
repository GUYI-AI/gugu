import { openFixture } from '@tooling/utils/db';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { mkdtemp,readdir,rm,writeFile,open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { readWindowFrame,writeWindowFrame } from './window-commit-projection-disk';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createWindowCommitReceipts,type WindowCommitReceipt } from './window-commit-receipt';
import { createWindowPackStore } from './window-pack-store';
const state = vi.hoisted(() => ({ db: undefined as AppDb|undefined,sqlite: undefined as Database.Database|undefined }));
vi.mock('@main/db/client',() => ({get db(){return state.db;},get sqlite(){return state.sqlite;} }));
vi.mock('@main/lib/events',() => ({events:{emit:vi.fn()}}));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('immutable projection pack and atomic point index',() => {
  let fixture: Awaited<ReturnType<typeof openFixture>>,directory:string,receipt:WindowCommitReceipt;
  let store: ReturnType<typeof createWindowPackStore>|undefined;
  beforeEach(async () => {
    fixture=await openFixture('empty');state.db=fixture.db;state.sqlite=fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory=await mkdtemp(join(tmpdir(),'window-pack-'));
    const turn:TranscriptTurn={id:'runtime:0',seq:0,referenceId:'ref',initiator:'user',items:[]};
    await persistCommittedTurn({sessionId:'c',source:'live',turn,windowCapture:{directory,scope:'a'.repeat(64),
      cursor:{workerEpoch:'worker',storeEpoch:'store',sequence:1},committed:async r=>{receipt=r!;} }});
  });
  afterEach(async () => {store?.close();store=undefined;fixture?.close();state.db=undefined;state.sqlite=undefined;vi.restoreAllMocks();
    if(directory)await rm(directory,{recursive:true,force:true});});
  const key=(cursor:string,head=false)=>({...receipt.binding,kind:head?'head' as const:'projection' as const,cursor});
  const read=(cursor:string,head=false)=>readWindowFrame(directory,key(cursor,head),createWindowBudget());
  const write=(cursor:string,value:string,head=false)=>writeWindowFrame(directory,key(cursor,head),Buffer.from(value));
  const text=(result:Awaited<ReturnType<typeof read>>)=>result.kind==='hit'?Buffer.from(result.bytes).toString():result;

  it('keeps private frames invisible until one pack and its whole SQLite position transaction are durable',async()=>{
    const probe=await open(directory,'r'),prototype=Object.getPrototypeOf(probe);await probe.close();
    const synced=vi.spyOn(prototype,'sync');
    const phases:string[]=[];store=createWindowPackStore(directory,fixture.sqlite,phase=>phases.push(phase));
    const ready=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const built=store.build([receipt],async()=>{await write('page','body');await write('head','old',true);
      expect(text(await read('page'))).toBe('body');ready.resolve();await release.promise;});
    await ready.promise;expect(await read('head',true)).toMatchObject({kind:'miss',reason:'not_found'});
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_pack_positions').get()).toEqual({n:0});
    release.resolve();await built;
    expect(phases).toEqual(['intent','pack_synced','directory_synced','positions_committed']);expect(synced).toHaveBeenCalledTimes(2);
    expect(text(await read('head',true))).toBe('old');expect(text(await read('page'))).toBe('body');
    expect((await readdir(directory)).filter(n=>n.endsWith('.frame'))).toEqual([]);
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_pack_groups WHERE state=\'complete\'').get()).toEqual({n:1});
    store.close();store=createWindowPackStore(directory,fixture.sqlite);expect(text(await read('page'))).toBe('body');
  });
  it('retains A checkpoint/page after B has written a new head but loses its publication, then recovers only B intent',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite);
    await store.build([receipt],async()=>{await write('A-page','A');await write('head','A-head',true);});store.close();
    let interrupt=true;store=createWindowPackStore(directory,fixture.sqlite,phase=>{if(interrupt&&phase==='directory_synced')throw new Error('crash before positions');});
    await expect(store.build([receipt],async()=>{expect(text(await read('A-page'))).toBe('A');await write('B-page','B');await write('head','B-head',true);}))
      .rejects.toThrow('crash before positions');interrupt=false;
    expect(text(await read('head',true))).toBe('A-head');expect(await read('B-page')).toMatchObject({kind:'miss'});
    const recovery=await store.recover();expect(recovery.anchors).toHaveLength(1);expect(recovery.anchors[0].sources).toEqual([receipt]);
    expect(text(await read('A-page'))).toBe('A');expect((await readdir(directory)).filter(n=>n.endsWith('.pack'))).toHaveLength(1);
    await store.build([receipt],async()=>{expect(text(await read('A-page'))).toBe('A');await write('B-page','B');await write('head','B-head',true);});
    expect(text(await read('head',true))).toBe('B-head');expect(text(await read('A-page'))).toBe('A');
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_pack_dependencies').get()).toEqual({n:1});
  });
  it('refuses positions if canonical DELETE removes its receipt after the pack directory sync',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite,phase=>{if(phase==='directory_synced')fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(receipt.rowId);});
    await expect(store.build([receipt],()=>write('page','deleted'))).rejects.toThrow('canonical receipt');
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_pack_positions').get()).toEqual({n:0});
    expect(await read('page')).toMatchObject({kind:'miss'});
  });
  it('checks cached point physical identity and refuses a replaced shared pack',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite);await store.build([receipt],()=>write('page','same size'));
    expect(text(await read('page'))).toBe('same size');
    const file=(await readdir(directory)).find(n=>n.endsWith('.pack'))!;
    await writeFile(join(directory,file),'corrupt');await expect(read('page')).rejects.toMatchObject({code:'needs_location'});
  });
  it('bounds progress packs to 128 appended frames and preserves old immutable pages across groups',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite);
    await store.build([receipt],async()=>{for(let i=0;i<130;i++)await write(`page:${i}`,`body:${i}`);});
    expect((await readdir(directory)).filter(n=>n.endsWith('.pack'))).toHaveLength(2);
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_pack_frames').get()).toEqual({n:130});
    expect(text(await read('page:0'))).toBe('body:0');expect(text(await read('page:129'))).toBe('body:129');
    await expect(store.build([receipt],()=>write('page:0','conflict'))).rejects.toMatchObject({code:'EEXIST'});
    expect(text(await read('page:0'))).toBe('body:0');
  });
  it('refuses a multi-pack publication after a middle pack of its build is deleted',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite);
    await store.build([receipt],async()=>{for(let i=0;i<300;i++)await write(`page:${i}`,`body:${i}`);await write('publication','final');});
    expect((await readdir(directory)).filter(n=>n.endsWith('.pack'))).toHaveLength(3);
    const proof=store.proof(windowFrameName(key('publication')));expect(()=>proof()).not.toThrow();
    const middle=fixture.sqlite.prepare('SELECT group_id g FROM session_window_pack_positions WHERE frame_name=?')
      .get(windowFrameName(key('page:150'))) as {g:string};
    const last=fixture.sqlite.prepare('SELECT group_id g FROM session_window_pack_positions WHERE frame_name=?')
      .get(windowFrameName(key('publication'))) as {g:string};
    expect(middle.g).not.toBe(last.g);
    await rm(join(directory,`${middle.g}.pack`));
    expect(()=>proof()).toThrow(expect.objectContaining({code:'needs_location'}));
    expect(()=>store!.proof(windowFrameName(key('publication')))()).toThrow(expect.objectContaining({code:'needs_location'}));
  });
  it('fails the build with needs_location when it would need a 129th pack',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite);
    await expect(store.build([receipt],async()=>{for(let i=0;i<128*128+1;i++)await write(`page:${i}`,'x');}))
      .rejects.toMatchObject({code:'needs_location'});
    expect(fixture.sqlite.prepare("SELECT count(*) n FROM session_window_pack_groups WHERE state='complete'").get()).toEqual({n:128});
    expect(fixture.sqlite.prepare("SELECT count(*) n FROM session_window_pack_groups WHERE state='building'").get()).toEqual({n:0});
  },120_000);
  it('rolls back every position if SQLite aborts after a new head but before the last page',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite);await store.build([receipt],()=>write('head','A',true));
    const target=windowFrameName(key('new-page'));
    fixture.sqlite.exec(`CREATE TRIGGER abort_pack_page BEFORE INSERT ON session_window_pack_frames WHEN NEW.frame_name='${target}' BEGIN SELECT RAISE(ABORT,'interrupted positions'); END`);
    await expect(store.build([receipt],async()=>{await write('head','B',true);await write('new-page','B');})).rejects.toThrow('interrupted positions');
    expect(text(await read('head',true))).toBe('A');expect(await read('new-page')).toMatchObject({kind:'miss'});
    fixture.sqlite.exec('DROP TRIGGER abort_pack_page');await store.recover();
  });
  it('does not block canonical deletion when committed groups depend on earlier frames',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite);await store.build([receipt],()=>write('page','A'));
    await store.build([receipt],async()=>{expect(text(await read('page'))).toBe('A');await write('head','B',true);});
    expect(()=>fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(receipt.rowId)).not.toThrow();
    expect(await read('page')).toMatchObject({kind:'miss'});expect(await read('head',true)).toMatchObject({kind:'miss'});
    expect(fixture.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
  it('rejects concurrent same-source builds and foreign frame owners without changing the public namespace',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite);const gate=Promise.withResolvers<void>();
    const built=store.build([receipt],()=>gate.promise);
    await expect(store.build([receipt],async()=>{})).rejects.toThrow('occupied');
    gate.resolve();await built;
    await expect(store.build([receipt],()=>writeWindowFrame(directory,{...key('wrong'),scope:'b'.repeat(64)},Buffer.from('bad')))).rejects.toThrow('another pack');
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_pack_positions').get()).toEqual({n:0});
  });
  it('pages nine interrupted groups as eight plus one without listing history directories',async()=>{
    store=createWindowPackStore(directory,fixture.sqlite,phase=>{if(phase==='intent')throw new Error('interrupted intent');});
    for(let i=0;i<9;i++)await expect(store.build([receipt],()=>write(`page:${i}`,'pending'))).rejects.toThrow('interrupted');
    const first=await store.recover();expect(first.anchors).toHaveLength(8);expect(first.next).not.toBeNull();
    const second=await store.recover(first.next!);expect(second.anchors).toHaveLength(1);expect(second.next).toBeNull();
    expect(await store.recover()).toEqual({anchors:[],next:null});
    expect(createWindowCommitReceipts(fixture.sqlite).bySource(receipt.sourceId)).toEqual(receipt);
  });
});
