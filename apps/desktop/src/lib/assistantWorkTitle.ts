import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
import type {Device} from '@gugu/core/shared/types/chat'
type TitlesDevice=Pick<Device,'device_id'|'session_digest'>
const digest=(device:TitlesDevice)=>Array.isArray(device.session_digest)?device.session_digest.filter(row=>
  row&&typeof row.conversationId==='string'&&typeof row.title==='string'):[]

/** The placeholder title a work is created with until its executor names its session. */
export const PLACEHOLDER_WORK_TITLE='任务'

/**
 * Display-only recovery for old placeholder rows (never rewrites a work or event), derived where it is drawn over the
 * account's devices. null = not known yet: the devices are not read, or an executor's row was carried across a restart
 * without its session digest (store/devicesCache.ts) — ❌ taken for "no title evidence" (CODE-REVIEW-1 R1).
 */
export function assistantWorkTitleOf(work:AssistantWorkTask,owner:string|null,devices:readonly TitlesDevice[]|null):string|null {
  if(work.title!==PLACEHOLDER_WORK_TITLE||!owner||work.owner_user_id!==owner)return work.title
  if(!devices)return null
  const rows=work.executors.map(executor=>devices.find(device=>device.device_id===executor.device_id))
  if(rows.some(row=>row&&row.session_digest===undefined))return null
  const titles=work.executors.map((executor,index)=>{
    const device=rows[index]
    const matches=device?digest(device).filter(row=>row.conversationId===executor.session_id):[]
    return matches.length===1?matches[0]!.title.trim():''
  })
  if(!titles.length||titles.some(title=>!title)||new Set(titles).size!==1)return work.title
  return titles[0]!
}
