// @vitest-environment jsdom
import {act} from 'react'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createReactHarness} from '../../../support/testHarness'
import {useLinkNavigation} from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import {OPEN_ASSISTANT_TASK_CHAT} from '../../../../apps/desktop/src/lib/assistantTaskChat'
import {UNAVAILABLE_APP_STATES,clearAssistantAppState,setAssistantAppState} from '../../../support/assistantAppStates'
const cloud=vi.hoisted(()=>({list:vi.fn()}))
vi.mock('react-i18next',async original=>({...await original<object>(),useTranslation:()=>({t:(key:string)=>key})}))
vi.mock('../../../../apps/desktop/src/lib/chat',()=>({chatService:{}}))
vi.mock('../../../../apps/desktop/src/lib/guguLinks',()=>({OPEN_LINK_TARGET:'gugu:open-link-target'}))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',()=>({assistantWorkCloud:{listAll:cloud.list}}))
vi.mock('../../../../apps/desktop/src/lib/assistantShellBridge',()=>({readAssistantShellBridge:()=>({getSnapshot:()=>({assistant:{id:'assistant'},ownerId:'owner',chatId:'assistant-dm'})})}))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory',async original=>({...await original<object>(),liveDeviceSessions:()=>[],listedSession:()=>{throw new Error('Must not resolve an account work through a device directory')}}))
vi.mock('../../../../apps/desktop/src/store/devicesCache',()=>({readCachedDevices:()=>[]}))
const harness=createReactHarness()
beforeEach(()=>setAssistantAppState('usable','owner'))
afterEach(()=>{harness.cleanup();clearAssistantAppState()})
it('opens a session link from its account work before any device or panel directory has received it',async()=>{
 const opened=vi.fn(),openAssistant=vi.fn()
 cloud.list.mockResolvedValue([{work_id:'new-work',assistant_user_id:'assistant',owner_user_id:'owner',title:'Just dispatched',executors:[{session_id:'prepared-session',device_id:'sleeping',agent_user_id:null}],coordinator_session_id:'main',coordinator_device_id:'home'}])
 function Navigation(){useLinkNavigation({ownerId:'owner',chats:() => [],contacts:() => [],openChat:vi.fn(),openFile:vi.fn(),openApp:vi.fn(),openProject:vi.fn(),openOwnApp:vi.fn(),openAssistant});return null}
 await harness.render(<Navigation/>);window.addEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)
 try{
  await act(async()=>{await new Promise<void>((resolve,reject)=>window.dispatchEvent(new CustomEvent('gugu:open-link-target',{detail:{target:{kind:'session',sessionId:'prepared-session'},resolve,reject},cancelable:true})))})
  expect(cloud.list).toHaveBeenCalledExactlyOnceWith('assistant')
  expect(openAssistant).toHaveBeenCalledWith(true)
  expect(opened.mock.calls[0][0].detail).toMatchObject({workId:'new-work',title:'Just dispatched',task:{sessionId:'prepared-session',deviceId:'sleeping'}})
 }finally{window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)}
})

// The App not usable here: a session of the assistant's task is an ordinary session, left to the host's task list to bring up —
// the link is not taken as the assistant's own, the ledger is not read, no panel is asked for.
describe.each(UNAVAILABLE_APP_STATES)('the App %s',state=>{
 it('leaves a task session to the host task list',async()=>{
  const harness=createReactHarness()
  cloud.list.mockClear()
  setAssistantAppState(state,'owner')
  const opened=vi.fn(),openAssistant=vi.fn()
  function Navigation(){useLinkNavigation({ownerId:'owner',chats:() => [],contacts:() => [],openChat:vi.fn(),openFile:vi.fn(),openApp:vi.fn(),openProject:vi.fn(),openOwnApp:vi.fn(),openAssistant});return null}
  await harness.render(<Navigation/>);window.addEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)
  try{
   let place:unknown='unset'
   await act(async()=>{place=await new Promise((resolve,reject)=>window.dispatchEvent(new CustomEvent('gugu:open-link-target',{detail:{target:{kind:'session',sessionId:'prepared-session'},resolve,reject},cancelable:true})))})
   expect(place).toBeUndefined()
   expect(cloud.list).not.toHaveBeenCalled()
   expect(opened).not.toHaveBeenCalled()
   expect(openAssistant).not.toHaveBeenCalled()
  }finally{window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT,opened);harness.cleanup()}
 })
})
