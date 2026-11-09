import { join } from 'node:path';
import { app } from 'electron';
import { sqlite } from '@main/db/client';
import { createWindowPackPublisher } from './window-pack-publisher';
import { ensureWindowCommitProjection, reserveWindowCommitHost as reserve } from './window-commit-host';
import type { WindowReceiptDatabase } from './window-commit-receipt';

// One cache backend for an application gateway, shared across worker generations.
// A replaced host retains only its own admitted callbacks and cannot close the
// next host's reader or namespace. Weak keys do not retain closed fixture DBs.
const publishers=new WeakMap<WindowReceiptDatabase,{directory:string;publisher:ReturnType<typeof createWindowPackPublisher>}>();
export function reserveWindowCommitHost(...input: Parameters<typeof reserve>) {
  ensureWindowCommitProjection(() => {
    const directory=join(app.getPath('userData'),'session-window-cache','committed');
    let shared=publishers.get(sqlite);
    if(shared&&shared.directory!==directory)throw new Error('Commit gateway changed its cache namespace');
    if(!shared){shared={directory,publisher:createWindowPackPublisher(directory,sqlite)};publishers.set(sqlite,shared);}
    const publisher=shared.publisher;let closing=false;
    return Object.assign((receipt: Parameters<typeof publisher.project>[0])=>publisher.project(receipt,closing),{
      flush(sessionId?:string){if(sessionId===undefined)closing=true;return publisher.flush(sessionId);},
    });
  });
  return reserve(...input);
}
