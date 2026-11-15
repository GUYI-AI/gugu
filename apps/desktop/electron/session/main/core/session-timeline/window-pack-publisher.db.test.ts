import { openFixture } from '@tooling/utils/db';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtemp,rm,readdir,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createWindowPackPublisher } from './window-pack-publisher';
import { createWindowCommitReceipts,type WindowCommitReceipt } from './window-commit-receipt';
import { readPublishedCommitEntity } from './window-commit-publisher';
import { openCommitBodySlot,readCommitBodySlot } from './window-commit-slot';
import { beginCanonicalQueueTask } from '../sessions/canonical-queue-state';
const state=vi.hoisted(()=>({db:undefined as AppDb|undefined,sqlite:undefined as Database.Database|undefined}));
vi.mock('@main/db/client',()=>({get db(){return state.db;},get sqlite(){return state.sqlite;}}));
vi.mock('@main/lib/events',()=>({events:{emit:vi.fn()}}));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('actual publisher with canonical idle group commit',()=>{
  let fixture:Awaited<ReturnType<typeof openFixture>>,directory:string,publisher:ReturnType<typeof createWindowPackPublisher>|undefined;
  const receipts:WindowCommitReceipt[]=[];
  beforeEach(async()=>{
    fixture=await openFixture('empty');state.db=fixture.db;state.sqlite=fixture.sqlite;fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory=await mkdtemp(join(tmpdir(),'window-pack-publisher-'));receipts.length=0;
    for(let i=0;i<2;i++){
      const turn:TranscriptTurn={id:`runtime:${i}`,seq:i,referenceId:`ref:${i}`,initiator:'user',items:[{kind:'message',id:`runtime:${i}:item`,seq:0,role:'assistant',text:`body:${i} 😀`}]};
      await persistCommittedTurn({sessionId:'c',source:'live',turn,windowCapture:{directory,scope:'a'.repeat(64),cursor:{workerEpoch:'w',storeEpoch:'s',sequence:i+1},
        committed:async r=>{receipts.push(r!);}}});
    }
  });
  afterEach(async()=>{await publisher?.close();publisher=undefined;vi.restoreAllMocks();fixture.close();state.db=undefined;state.sqlite=undefined;
    await rm(directory,{recursive:true,force:true});});
  it('groups adjacent receipts while busy, then flushes immediately on real idle and point reads the actual body',async()=>{
    const completed=beginCanonicalQueueTask('c'),phase=vi.fn();publisher=createWindowPackPublisher(directory,fixture.sqlite,{phase});
    const a=publisher.project(receipts[0]),b=publisher.project(receipts[1]);
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_pack_groups').get()).toEqual({n:0});
    completed();const [first,second]=await Promise.all([a,b]);
    expect(phase).toHaveBeenCalledTimes(2);expect(fixture.sqlite.prepare("SELECT count(*) n FROM session_window_pack_groups WHERE state='complete'").get()).toEqual({n:1});
    expect(first.projectionId).not.toBe(second.projectionId);
    const c={directory,receipt:receipts[1],receipts:createWindowCommitReceipts(fixture.sqlite)};
    const row=await readPublishedCommitEntity(c,second.projectionId,0,createWindowBudget());
    const slot=openCommitBodySlot(directory,c.receipts,c.receipt,row.facts,'text',row.bodyBuildId);
    expect(await readCommitBodySlot(slot,0,createWindowBudget())).toMatchObject({kind:'body',text:'body:1 😀'});
  });
  it('does not arm the busy timer when the idle transition happened before a delayed preparation registered',async()=>{
    const completed=beginCanonicalQueueTask('c');completed();const timer=vi.spyOn(globalThis,'setTimeout');
    publisher=createWindowPackPublisher(directory,fixture.sqlite);await publisher.project(receipts[0]);
    expect(timer.mock.calls.filter(([,ms])=>ms===80)).toHaveLength(0);
  });
  it('flushes an underfilled busy group on explicit close without waiting for its timer or the overall persistence promise',async()=>{
    const completed=beginCanonicalQueueTask('c');publisher=createWindowPackPublisher(directory,fixture.sqlite);
    const admitted=publisher.project(receipts[0]);await publisher.close();publisher=undefined;
    expect((await admitted).projectionId).toContain(receipts[0].sourceId);completed();
  });
  it('publishes a multi-pack actual turn and reopens its last real entity/body with the same request budget',async()=>{
    const turn:TranscriptTurn={id:'runtime:giant',seq:2,referenceId:'giant-ref',initiator:'user',items:Array.from({length:20},(_,i)=>({
      kind:'message' as const,id:`runtime:giant:${i}`,seq:i,role:'assistant' as const,text:`body:${i}:`+'中文😀'.repeat(1024)
    }))};let receipt!:WindowCommitReceipt;
    await persistCommittedTurn({sessionId:'c',source:'live',turn,windowCapture:{directory,scope:'a'.repeat(64),cursor:{workerEpoch:'w',storeEpoch:'s',sequence:3},committed:async r=>{receipt=r!;}}});
    const counters:number[]=[];publisher=createWindowPackPublisher(directory,fixture.sqlite,{observed:io=>counters.push(io.indexBytes)});
    const projected=await publisher.project(receipt);projected.validate?.();
    const files=(await readdir(directory)).filter(n=>n.endsWith('.pack'));expect(files.length).toBeGreaterThan(1);
    for(const file of files)expect((await stat(join(directory,file))).size).toBeLessThanOrEqual(4*1024*1024);
    expect(counters.every(n=>n<=65536)).toBe(true);await publisher.close();publisher=createWindowPackPublisher(directory,fixture.sqlite);
    const c={directory,receipt,receipts:createWindowCommitReceipts(fixture.sqlite)},budget=createWindowBudget();
    const row=await readPublishedCommitEntity(c,projected.projectionId,19,budget);expect(row.ordinal).toBe(19);
    const slot=openCommitBodySlot(directory,c.receipts,receipt,row.facts,'text',row.bodyBuildId);
    expect(await readCommitBodySlot(slot,0,createWindowBudget())).toMatchObject({kind:'body',text:'body:19:'+'中文😀'.repeat(1024)});
  },30000);
  it('rejects the final publication proof when its pack disappears after preparation returned',async()=>{
    publisher=createWindowPackPublisher(directory,fixture.sqlite);const projected=await publisher.project(receipts[0]);projected.validate?.();
    for(const file of (await readdir(directory)).filter(n=>n.endsWith('.pack')))await rm(join(directory,file));
    expect(()=>projected.validate?.()).toThrow(expect.objectContaining({code:'needs_location'}));
  });
  it('rejects journal validation after canonical DELETE even if the packed projection was durable',async()=>{
    publisher=createWindowPackPublisher(directory,fixture.sqlite);const projected=await publisher.project(receipts[0]);projected.validate?.();
    fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(receipts[0].rowId);
    expect(()=>projected.validate?.()).toThrow(expect.objectContaining({code:'needs_location'}));
  });
});
