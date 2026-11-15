import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { PhoneSessionSidebarControls } from '@/mobile/chat/PhoneSessionSidebarControls'
import { PhoneComposerControlRow } from '@/mobile/composer/PhoneComposerControls'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { publishDirectoryDevices, updateDeviceSessions, removeDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { publishChatSummaries } from '@/lib/chatSummariesBridge'
import { installOwnedAgentEntry } from '@/lib/ownedAgentConversation'
import { APP_SHOW_SESSION_EVENT } from '@/session/shared/extensions/app-runtime-protocol'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { chat, device, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

let harness: ReturnType<typeof createReactHarness>|undefined
let dispose: (()=>void)|undefined
const sessions=[
 {conversationId:'room-task',title:'群里的验收任务',agent:{userId:'room-agent'},bornInChatId:'room'},
 {conversationId:'solo',title:'独立智能体',agent:{userId:'solo-agent'}},
 {conversationId:'child',title:'排版子智能体',agent:{userId:'child-agent'},parentConversationId:'solo'},
 {conversationId:'other',title:'别处的任务',agent:{userId:'other-agent'}},
].map(session=>({...session,projectId:'workspace',harness:'codex',runtime:'acp',agentStatus:'idle'} as SessionpageSessionSummary))
async function mount(sessionId:string,entry:string|null){
 await page.viewport(390,844);document.documentElement.dataset.theme='dark';document.documentElement.setAttribute('data-phone-shell','');setLocalePreference('zh-CN')
 const chats=[chat({id:'room',kind:'group',name:'手机验收群'}),chat({id:'solo-chat',kind:'dm',peer_user_id:'solo-agent',name:'独立智能体'})]
 publishChatSummaries(chats);dispose=installOwnedAgentEntry({open:()=>false,owns:()=>true})
 publishDirectoryDevices([device('qa-device',[],{is_online:true})]);updateDeviceSessions('qa-device',{projects:[{id:'workspace',name:'Tasks',path:'',kind:'workspace'}],sessions,cached:false,loading:false,error:null})
 harness=createReactHarness();Object.assign(harness.container.style,{position:'fixed',inset:'0',display:'flex',flexDirection:'column',justifyContent:'flex-end',padding:'8px'})
 await renderWithAppProviders(harness,<LocalizationProvider><SessionUiTheme theme="dark"><PhoneSessionSidebarControls sessionId={sessionId} entry={entry}/><PhoneComposerControlRow><span>输入消息</span></PhoneComposerControlRow></SessionUiTheme></LocalizationProvider>,{auth:{id:'owner'},chat:{chats},contacts:{contacts:[]}})
}
afterEach(()=>{harness?.cleanup();dispose?.();removeDeviceSessions('qa-device');publishDirectoryDevices([]);document.documentElement.removeAttribute('data-phone-shell')})
it('a group-entered task lists the same resident sessions and preserves the group entry when switching',async()=>{
 await mount('room-task','chat:room');await page.getByTestId('phone-room-agents').click()
 await expect.element(page.getByTestId('phone-sidebar-agent')).toHaveTextContent('群里的验收任务')
 expect(document.querySelectorAll('[data-testid="phone-sidebar-agent"]')).toHaveLength(1)
 const opened: unknown[]=[];const capture=(event:Event)=>opened.push((event as CustomEvent).detail);window.addEventListener(APP_SHOW_SESSION_EVENT,capture)
 try { await page.getByTestId('phone-sidebar-agent').click();expect(opened).toEqual([expect.objectContaining({innerSidebarEntry:'chat:room',session:expect.objectContaining({conversationId:'room-task'})})]) } finally {window.removeEventListener(APP_SHOW_SESSION_EVENT,capture)}
})
it('a standalone Agent offers only its children and no Topics button',async()=>{
 await mount('solo',null);await until('standalone anchor',()=>!!document.querySelector('[data-anchor-kind="agent"]'))
 expect(document.querySelector('[data-testid="phone-room-topics"]')).toBeNull();await page.getByTestId('phone-room-agents').click()
 await expect.element(page.getByTestId('phone-sidebar-agent')).toHaveTextContent('排版子智能体');expect(document.querySelectorAll('[data-testid="phone-sidebar-agent"]')).toHaveLength(1)
})
it('an unrelated task has neither control',async()=>{
 await mount('other','chat:room');expect(document.querySelector('[data-testid="phone-session-sidebar-controls"]')).toBeNull()
})
