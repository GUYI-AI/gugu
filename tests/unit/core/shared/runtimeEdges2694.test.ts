import { expect, it } from 'vitest'
import { LifecycleMap } from '../../../../packages/session-shared/src/lifecycle-map'
import { ok } from '../../../../packages/session-shared/src/result'
import { LiveCollection } from '../../../../packages/session-core/src/lib/live-collection'
import { createCachedFileSink, type FileChunkCache } from '@gugu/core/shared/fileCache'
import { SessionBootTasks } from '@gugu/core/shared/sessionBootTasks'
import { prepareFields, serializeError } from '../../../../packages/session-shared/src/logger/prepare'
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

it('keeps teardown in flight through its post hook', async () => { const done=deferred<void>(); const entered=deferred<void>(); const map=new LifecycleMap<string,string,string>({postTeardown:async()=>{entered.resolve();await done.promise}}); await map.provision('k',async()=>ok('v')); const first=map.teardown('k',async()=>ok())!; await entered.promise; const second=map.teardown('k',async()=>ok()); try {expect(second).toBe(first);expect(map.teardownStatus('k').status).toBe('bootstrapping')} finally {done.resolve();await first} })
