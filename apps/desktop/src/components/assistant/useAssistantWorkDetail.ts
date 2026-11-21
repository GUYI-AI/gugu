import {useMemo} from 'react'
import {useReplica} from '../../lib/replica'
import {assistantWork,useAssistantWorkTitles} from './assistant-work-records'

type Detail=Awaited<ReturnType<typeof assistantWork.fetch>>

/**
 * One work as its window draws it. A work not matching the address (owner, assistant, work id, the session among its
 * executors) is said as unreadable, ❌ drawn. Neither executor admission nor a host connection gates the first paint.
 */
export function useAssistantWorkDetail(ownerId:string,assistantId:string,workId:string,sessionId:string):{detail:(Detail&{titleKnown:boolean})|null;error?:unknown}{
 const reading=useReplica(assistantWork,[assistantId,workId])
 const value=reading.state==='value'?reading.value:null
 const matches=!!value&&value.work.owner_user_id===ownerId&&value.work.assistant_user_id===assistantId&&value.work.work_id===workId
   &&value.work.executors.some(row=>row.session_id===sessionId)
 const titled=useAssistantWorkTitles(ownerId,matches&&value?[value.work]:null)
 return useMemo(()=>{
  const mismatch=value&&!matches?new Error('Task address does not match its account record'):undefined
  const error=reading.state==='error'?reading.error:mismatch??(reading.state==='value'?reading.error??undefined:undefined)
  const detail=matches&&value&&titled?{...value,work:titled[0]!,titleKnown:titled[0]!.titleKnown}:null
  return error===undefined?{detail}:{detail,error}
 },[reading,value,matches,titled])
}
