type State = { pending: number; generation: number; listeners: Set<() => void> };
const states = new Map<string,State>();
function state(sessionId: string) {
  let value=states.get(sessionId);
  if(!value){value={pending:0,generation:0,listeners:new Set()};states.set(sessionId,value);}return value;
}
function collect(sessionId:string,value:State){if(!value.pending&&!value.listeners.size&&states.get(sessionId)===value)states.delete(sessionId);}
/** Enqueue and completion belong to the canonical tail, never the projection
 * promise. Idle is readable state, so a late projection cannot lose a hint. */
export function beginCanonicalQueueTask(sessionId:string){
  const value=state(sessionId);value.pending++;value.generation++;let finished=false;
  return ()=>{if(finished)return;finished=true;value.pending--;value.generation++;
    if(!value.pending)for(const listener of [...value.listeners]){try{listener();}catch{/* A cache observer cannot fail canonical persistence. */}}
    collect(sessionId,value);
  };
}
export function observeCanonicalQueue(sessionId:string,idle:()=>void){
  const value=state(sessionId);value.listeners.add(idle);let closed=false;
  return {snapshot(){if(closed)throw new Error('Canonical queue observation was released');return {pending:value.pending,generation:value.generation};},
    close(){if(closed)return;closed=true;value.listeners.delete(idle);collect(sessionId,value);}};
}
