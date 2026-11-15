import { openFixture } from '@tooling/utils/db';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createWindowPackPublisher } from './window-pack-publisher';
import { isWindowPackCapacityFault } from './window-pack-store';
import { createWindowCommitReceipts,type WindowCommitReceipt } from './window-commit-receipt';
import { readPublishedCommitEntity } from './window-commit-publisher';
import { beginCanonicalQueueTask } from '../sessions/canonical-queue-state';
const state=vi.hoisted(()=>({db:undefined as AppDb|undefined,sqlite:undefined as Database.Database|undefined}));
vi.mock('@main/db/client',()=>({get db(){return state.db;},get sqlite(){return state.sqlite;}}));
vi.mock('@main/lib/events',()=>({events:{emit:vi.fn()}}));
import { persistCommittedTurn } from '../sessions/session-turn-store';

/** A small pack capacity stands in for the production 128 so medium and giant
 * turns stay fast; the publisher's splitting does not depend on its value. */
const PACKS=4;
describe('pack builds near their bounded capacity',()=>{
  let fixture:Awaited<ReturnType<typeof openFixture>>,directory:string,publisher:ReturnType<typeof createWindowPackPublisher>|undefined,sequence=0;
  beforeEach(async()=>{
    fixture=await openFixture('empty');state.db=fixture.db;state.sqlite=fixture.sqlite;sequence=0;
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory=await mkdtemp(join(tmpdir(),'window-pack-split-'));
  });
  afterEach(async()=>{await publisher?.close();publisher=undefined;vi.restoreAllMocks();fixture.close();state.db=undefined;state.sqlite=undefined;
    await rm(directory,{recursive:true,force:true});});
  async function turn(name:string,items:number){
    let receipt!:WindowCommitReceipt;const at=++sequence;
    const value:TranscriptTurn={id:name,seq:at,referenceId:`${name}-ref`,initiator:'user',items:Array.from({length:items},(_,i)=>({
      kind:'message' as const,id:`${name}:${i}`,seq:i,role:'assistant' as const,text:`${name} body ${i}`}))};
    await persistCommittedTurn({sessionId:'c',source:'live',turn:value,windowCapture:{directory,scope:'a'.repeat(64),
      cursor:{workerEpoch:'w',storeEpoch:'s',sequence:at},committed:async r=>{receipt=r!;}}});
    return receipt;
  }
  const widestBuild=()=>(fixture.sqlite.prepare(`SELECT coalesce(max(n),0) n FROM (SELECT count(*) n FROM session_window_pack_dependencies GROUP BY group_id)`).get() as {n:number}).n;
  async function readable(receipt:WindowCommitReceipt,projectionId:string,last:number){
    const c={directory,receipt,receipts:createWindowCommitReceipts(fixture.sqlite)};
    expect((await readPublishedCommitEntity(c,projectionId,last,createWindowBudget())).ordinal).toBe(last);
  }

  it('splits eight merged medium turns whose total exceeds the capacity and publishes every one',async()=>{
    const receipts:WindowCommitReceipt[]=[];for(let i=0;i<8;i++)receipts.push(await turn(`medium-${i}`,12));
    const busy=beginCanonicalQueueTask('c');publisher=createWindowPackPublisher(directory,fixture.sqlite,{packs:PACKS});
    const projected=receipts.map(r=>publisher!.project(r));busy();
    const results=await Promise.all(projected);
    for(let i=0;i<8;i++)await readable(receipts[i],results[i].projectionId,11);
    // Every publication is provable within one bounded build.
    expect(widestBuild()).toBeLessThan(PACKS);
    expect((fixture.sqlite.prepare("SELECT count(*) n FROM session_window_pack_groups WHERE state='complete'").get() as {n:number}).n).toBeGreaterThan(PACKS);
  },120_000);

  it('fails only a single turn that alone exceeds the capacity; the turns merged with it publish',async()=>{
    const before=await turn('before',2),giant=await turn('giant',60),after=await turn('after',2);
    const busy=beginCanonicalQueueTask('c');publisher=createWindowPackPublisher(directory,fixture.sqlite,{packs:PACKS});
    const projected=[before,giant,after].map(r=>publisher!.project(r).then(value=>({ok:true as const,value}),error=>({ok:false as const,error})));busy();
    const [a,g,b]=await Promise.all(projected);
    expect(g.ok).toBe(false);expect(isWindowPackCapacityFault(!g.ok&&g.error)).toBe(true);
    expect(a.ok&&b.ok).toBe(true);
    await readable(before,a.ok?a.value.projectionId:'',1);await readable(after,b.ok?b.value.projectionId:'',1);
    expect(widestBuild()).toBeLessThan(PACKS);
  },120_000);
});
