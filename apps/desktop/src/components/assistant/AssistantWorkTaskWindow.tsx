import {useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import type {ContactUser} from '@gugu/core/shared/types/contacts'
import {withAssistantPanelReadDeadline,isAssistantPanelReadRetryable} from '@gugu/core/cloud/assistantPanelRead'
import {rememberAssistantTaskChat,showAssistantTaskChat,useOpenedAssistantTaskChat,type AssistantTaskChat} from '../../lib/assistantTaskChat'
import {assistantWorkTarget} from '../../lib/assistantWorkTarget'
import {readRequiredDisplayIdentities} from '../../lib/identityReadAdapter'
import {useContactsStore} from '../../store/contactsContext'
import {useMobileShell} from '../../hooks/useMobileShell'
import {useToast} from '../toastContext'
import {PaneHeader} from '../ui/Pane'
import {IconButton} from '../ui/IconButton'
import {ChevronLeft} from '../../lib/icons'
import {AssistantTaskChatWindow} from './AssistantTaskChatWindow'
import {useAssistantWorkDetail} from './useAssistantWorkDetail'
import {assistantWorkExchanges} from './assistant-work-projection'
import {taskChatRows} from './taskChatRows'
import {TaskExchangeBubble} from './TaskExchangeBubble'
import {TaskChatFilePreviewHost} from './TaskChatFilePreviewHost'
import {useMessageFilePreview} from '../chat/useMessageFilePreview'
import {useAssistantWorkRuntime} from './useAssistantWorkRuntime'
import {ConnectionStatus} from '../connection/ConnectionStatus'

/**
 * `onClose`: what its back control does — the assistant's own panel by default; an App's panel takes its own (#1925).
 * `appPanel`: drawn over an App's panel, read as part of it (AssistantTaskChatWindow).
 */
export function AssistantWorkTaskWindow({ownerId,request,onClose,appPanel=false}:{ownerId:string;request:AssistantTaskChat;onClose?:()=>void;appPanel?:boolean}){
 const {t}=useTranslation('assistant'),mobile=useMobileShell()
 const {contacts}=useContactsStore(),opened=useOpenedAssistantTaskChat()
 const read=useAssistantWorkDetail(ownerId,request.assistantId,request.workId!,request.task.sessionId)
 const detail=read.detail
 const canonical=detail?assistantWorkTarget(detail.work,request.task.sessionId):null
 const runtime=useAssistantWorkRuntime(canonical?.task.deviceId??null)
 const agentId=canonical?.taskAgentId??null
 const contact=contacts.find(row=>row.id===agentId&&row.type==='agent'&&row.owner_user_id===ownerId)
 const [identity,setIdentity]=useState<{ownerId:string;agent:ContactUser}|null>(null)
 const [identityFailed,setIdentityFailed]=useState(false)
 useEffect(()=>{
  if(!agentId||contact||identity?.ownerId===ownerId&&identity.agent.id===agentId){setIdentityFailed(false);return}
  let alive=true,failures=0,timer:ReturnType<typeof setTimeout>|undefined
  setIdentityFailed(false)
  const readIdentity=async()=>{
   try{
    const rows=await withAssistantPanelReadDeadline(()=>readRequiredDisplayIdentities([agentId]))
    const agent=rows.find(row=>row.id===agentId&&row.type==='agent'&&row.owner_user_id===ownerId)
    if(!agent)throw new Error('Task identity is not owned by this account')
    if(alive){setIdentity({ownerId,agent});setIdentityFailed(false)}
   }catch(error){
    if(!alive)return
    setIdentityFailed(true)
    if(failures++<2&&isAssistantPanelReadRetryable(error))timer=setTimeout(()=>void readIdentity(),1500)
   }
  }
  void readIdentity()
  return()=>{alive=false;clearTimeout(timer)}
 },[agentId,ownerId,contact,detail?.work,identity])
 const remembered=useRef('')
 const canonicalKey=canonical?JSON.stringify(canonical):''
 useEffect(()=>{
  if(!canonical||remembered.current===canonicalKey)return
  remembered.current=canonicalKey
  rememberAssistantTaskChat(ownerId,canonical)
  if(opened?.ownerId===ownerId&&opened.request.workId===canonical.workId&&JSON.stringify(opened.request)!==canonicalKey)
   showAssistantTaskChat({ownerId,request:canonical,name:canonical.title!})
 },[ownerId,canonicalKey,canonical,opened])
 const agent=contact??(identity?.ownerId===ownerId&&identity.agent.id===agentId?identity.agent:null)
 const title=detail?.work.title??request.title??t('tasks.title')
 const state=detail?.work.outcome??request.outcome??'active'
 const workState=t(state==='active'&&!agentId?'tasks.starting':`tasks.workState.${state}`)
 // owner 11-08: the computer's connection state and what could not be read sit in the header subtitle, ❌ lines under it.
 const unreadable=read.error||identityFailed?t('tasks.chatUnavailable'):null
 const status=runtime.connection==='online'&&!unreadable?workState:<span className="task-chat-subtitle">
  <span className="task-chat-subtitle__state">{workState}</span>
  {runtime.connection!=='online'?<ConnectionStatus state={runtime.connection} lastSeenAt={runtime.lastSeenAt} detail={runtime.detail} testId="assistant-task-connection-status"/>:null}
  {unreadable?<span className="task-chat-subtitle__detail" role="status" title={unreadable}>{unreadable}</span>:null}
 </span>
 const close=onClose??(()=>showAssistantTaskChat(null))
 const transcript=<CloudTaskTranscript mobile={mobile} request={canonical??request} events={detail?.events??[]}/>
 if(agent)return <AssistantTaskChatWindow agent={{...agent,display_name:title}} task={(canonical??request).task} onClose={close} status={status} pendingContent={transcript} appPanel={appPanel}/>
 return <section className="assistant-task-chat-window ta-skin" data-testid="assistant-task-chat-window" data-app-panel={appPanel||undefined} aria-label={title}>
  <TaskChatFilePreviewHost mobile={mobile}>
   <PaneHeader title={title} subtitle={status} mobile={mobile} divider leading={<IconButton aria-label={t('panel.back')} onClick={close} data-testid="assistant-task-chat-close"><ChevronLeft/></IconButton>}/>
   {transcript}
  </TaskChatFilePreviewHost>
 </section>
}

function CloudTaskTranscript({mobile,request,events}:{mobile:boolean;request:AssistantTaskChat;events:Parameters<typeof assistantWorkExchanges>[0]}){
 const {toast}=useToast()
 const preview=useMessageFilePreview({mobile,visible:true,closeRightSurfaces:()=>{},toast,onForward:()=>{}})
 const rows=taskChatRows([],assistantWorkExchanges(events,request.workId!),request)
 return <><div className="assistant-task-cloud-history" data-testid="task-cloud-history">{rows.map(row=>row.type==='task-exchange'?<TaskExchangeBubble key={row.message.id} message={row.message} recipientUserId={row.recipientUserId} mobile={mobile} onOpenFile={file=>preview.open(file)}/>:null)}</div>{preview.panel}</>
}
