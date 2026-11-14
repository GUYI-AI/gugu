import { expect, it } from 'vitest'
import { LifecycleMap } from '../../../../packages/session-shared/src/lifecycle-map'
import { ok } from '../../../../packages/session-shared/src/result'
import { LiveCollection } from '../../../../packages/session-core/src/lib/live-collection'
import { createCachedFileSink, type FileChunkCache } from '@gugu/core/shared/fileCache'
import { SessionBootTasks } from '@gugu/core/shared/sessionBootTasks'
import { prepareFields, serializeError } from '../../../../packages/session-shared/src/logger/prepare'
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

it('keeps teardown in flight through its post hook', async () => { const done=deferred<void>(); const entered=deferred<void>(); const map=new LifecycleMap<string,string,string>({postTeardown:async()=>{entered.resolve();await done.promise}}); await map.provision('k',async()=>ok('v')); const first=map.teardown('k',async()=>ok())!; await entered.promise; const second=map.teardown('k',async()=>ok()); try {expect(second).toBe(first);expect(map.teardownStatus('k').status).toBe('bootstrapping')} finally {done.resolve();await first} })

it('does not mark disposed collections as loaded', async () => { const gate=deferred<{ success: true; data: Array<[string, {scope: string}]> }>(); const collection=new LiveCollection<string,{scope:string}>({scopeOf:v=>v.scope}); const load=collection.loadScope('s',()=>gate.promise); collection.dispose(); gate.resolve(ok([['k',{scope:'s'}]])); await expect(load).rejects.toThrow('disposed'); expect(collection.isScopeLoaded('s')).toBe(false) })

it('rejects cached reads disposed during async cache access', async () => { const gate=deferred<Uint8Array>(); const entered=deferred<void>(); const cache:FileChunkCache={put:async()=>{},clear:async()=>{},get:async()=>{entered.resolve();return gate.promise}};const sink=createCachedFileSink(cache,1);await sink.write(new Uint8Array([1]));const file=await sink.commit();const read=file.read(0,1);await entered.promise;await file.dispose();gate.resolve(new Uint8Array([1]));await expect(read).rejects.toThrow('disposed') })
