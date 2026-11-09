import { setImmediate } from 'node:timers/promises';
import { createWindowCommitPublisher, type WindowCommitPublication } from './window-commit-publisher';
import { createWindowCommitReceipts,snapshotWindowCommitReceipt,type WindowCommitReceipt,type WindowReceiptDatabase } from './window-commit-receipt';
import { createWindowPackStore, isWindowPackCapacityFault } from './window-pack-store';
import { observeCanonicalQueue } from '../sessions/canonical-queue-state';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import type { WindowCommitProjection } from './window-commit-runtime';

/** `alone`: split out of a merged build that exceeded its pack capacity. */
type Job={receipt:WindowCommitReceipt;alone?:boolean;resolve(value:WindowCommitProjection):void;reject(error:unknown):void};
type Queue={sessionId:string;jobs:Job[];running:boolean;requested:boolean;processing:number;timer?:ReturnType<typeof setTimeout>;
  idle:ReturnType<typeof observeCanonicalQueue>;drained:ReturnType<typeof Promise.withResolvers<void>>};
type Ports=NonNullable<Parameters<typeof createWindowCommitPublisher>[2]>&{packs?:number};
/** Same-conversation receipts share one durable pack. The busy timeout is only a
 * ceiling; an idle canonical queue, explicit flush and close act immediately.
 * A merged build stops admitting turns once half its pack capacity is used, and
 * if it still exceeds the capacity each of its turns is rebuilt on its own (the
 * publisher resumes from its durable progress), so only a turn that alone
 * exceeds it fails, with the capacity fault. */
export function createWindowPackPublisher(directory:string,db:WindowReceiptDatabase,ports:Ports={}){
  const receipts=createWindowCommitReceipts(db),store=createWindowPackStore(directory,db,undefined,ports.packs===undefined?undefined:{packs:ports.packs});
  const publisher=createWindowCommitPublisher(directory,receipts,{observed:ports.observed,report:ports.report});
  const queues=new Map<string,Queue>();let closed=false,recovery:Promise<void>|undefined;
  const recovered=()=>recovery??=(async()=>{
    let after='';for(;;){const page=await store.recover(after);if(!page.next)return;after=page.next;await setImmediate();}
  })();
  const report=(error:unknown)=>{try{ports.report?.(error);}catch{/* Diagnostic observer only. */}};
  function request(q:Queue){if(queues.get(q.sessionId)!==q)return;q.requested=true;if(q.timer){clearTimeout(q.timer);q.timer=undefined;}void pump(q);}
  function consider(q:Queue){
    // Register jobs first, then synchronously recheck the real queue state.
    if(q.jobs.length>=8||q.idle.snapshot().pending===0)request(q);
    else if(!q.timer)q.timer=setTimeout(()=>{q.timer=undefined;request(q);},80);
  }
  async function pump(q:Queue){
    if(q.running||!q.requested)return;q.running=true;
    try{
      while(q.requested&&q.jobs.length){
        q.requested=false;
        let take=0;if(q.jobs[0].alone)take=1;else while(take<8&&take<q.jobs.length&&!q.jobs[take].alone)take++;
        const jobs=q.jobs.splice(0,take),published:WindowCommitPublication[]=[];q.processing=jobs.length;
        try{
          await recovered();
          await store.build(jobs.map(j=>j.receipt),async()=>{for(const job of jobs){
            if(published.length&&store.used()*2>=store.capacity)break;
            published.push(await publisher.publish(job.receipt));
          }});
          // Turns this build stopped admitting go first in the next one.
          if(published.length<jobs.length){q.jobs.unshift(...jobs.slice(published.length));q.requested=true;}
          for(let i=0;i<published.length;i++){
            const job=jobs[i],expected=JSON.stringify(job.receipt),publication=published[i];
            const proof=store.proof(windowFrameName({...job.receipt.binding,kind:'projection',cursor:`publisher:${publication.buildId}:publication`}));
            const validate=()=>{proof();if(JSON.stringify(receipts.bySource(job.receipt.sourceId))!==expected)
              throw Object.assign(new Error('Canonical receipt changed before packed journal publication'),{code:'needs_location'});};
            validate();try{ports.phase?.('projection_durable',publication);}catch(error){report(error);}
            job.resolve({projectionId:publication.projectionId,validate});
          }
        }catch(error){
          if(jobs.length>1&&isWindowPackCapacityFault(error)){for(const job of jobs)job.alone=true;q.jobs.unshift(...jobs);q.requested=true;}
          else for(const job of jobs)job.reject(error);
        }finally{q.processing=0;}
        if(q.jobs.length&&!q.requested)consider(q);
      }
    }finally{
      q.running=false;
      if(!q.jobs.length){if(q.timer)clearTimeout(q.timer);q.idle.close();if(queues.get(q.sessionId)===q)queues.delete(q.sessionId);q.drained.resolve();}
      else if(q.requested)void pump(q);
    }
  }
  const project=(input:WindowCommitReceipt,immediate=false):Promise<WindowCommitProjection>=>{
    if(closed)return Promise.reject(new Error('Packed publisher has been released'));
    const receipt=snapshotWindowCommitReceipt(input);let q=queues.get(receipt.sessionId);
    if(!q){
      if(queues.size>=32)return Promise.reject(new Error('Too many projection queues'));
      const value:Queue={sessionId:receipt.sessionId,jobs:[],running:false,requested:false,processing:0,idle:undefined!,drained:Promise.withResolvers<void>()};
      value.idle=observeCanonicalQueue(receipt.sessionId,()=>request(value));queues.set(receipt.sessionId,value);q=value;
    }
    if(q.jobs.length+q.processing>=64)return Promise.reject(new Error('Pending projection capacity exceeded'));
    const result=new Promise<WindowCommitProjection>((resolve,reject)=>q!.jobs.push({receipt,resolve,reject}));if(immediate)request(q);else consider(q);return result;
  };
  const flush=async(sessionId?:string)=>{const pending=[...queues.values()].filter(q=>sessionId===undefined||q.sessionId===sessionId);for(const q of pending)request(q);await Promise.all(pending.map(q=>q.drained.promise));};
  return {project,flush,recover:store.recover,async close(){closed=true;await flush();store.close();}};
}
