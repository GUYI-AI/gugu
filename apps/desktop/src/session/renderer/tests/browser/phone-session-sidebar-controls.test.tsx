import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { observer } from 'mobx-react-lite'
import { runInAction } from 'mobx'
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store'
import { UI_EVENTS } from '@/lib/uiEvents'
import { usePhoneSessionSidebar } from '@/mobile/chat/usePhoneSessionSidebar'
import { PhoneSessionSidebarControls } from '@/mobile/chat/PhoneSessionSidebarControls'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { AgentWatchScreen } from '@/mobile/agent-watch/AgentWatchChrome'
import { followRendererSession } from '@/lib/replica'
import '@/mobile/agent-watch/agent-watch.css'
import '@/mobile/agent-watch/phone-conversation.css'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@renderer/index.css'
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

const actions = vi.hoisted(() => ({ pickModel: vi.fn(), send: vi.fn(), reloadTopics: vi.fn(), topicError: null as string | null }))
vi.mock('@/hooks/useTopics', async original => ({ ...(await original<object>()), useTopicsOfChat: () => ({ topics: null, loading: actions.topicError === null, error: actions.topicError, reload: actions.reloadTopics }) }))
vi.mock('@/components/chat/useConversationOptions', () => ({ useConversationOptions: () => ({ props: {
  modelOptions: { glm: { name: '咕咕 GLM-5.3' }, luna: { name: '咕咕 GPT-6 Luna' } }, selectedModel: 'glm', onModelChange: actions.pickModel,
}, confirmation: null, steers: false }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => {
  const real = await original<typeof import('@/mobile/agent-watch/sessionpage-rpc')>()
  return { ...real, machineRpc: (...args: Parameters<typeof real.machineRpc>) => {
    const rpc = real.machineRpc(...args)
    return { ...rpc, sessionTimeline: { ...rpc.sessionTimeline, sessionCreateSkills: async () => ({ ok: true, value: { skills: [{ id: 'native/review/SKILL.md', name: '代码检查', description: '检查当前改动' }] } }) } }
  } }
})
let harness: ReturnType<typeof createReactHarness>|undefined
let dispose: (()=>void)|undefined
const sessions=[
 {conversationId:'room-task',title:'群里的验收任务',agent:{userId:'room-agent'},bornInChatId:'room'},
 {conversationId:'solo',title:'独立智能体',agent:{userId:'solo-agent'}},
 {conversationId:'child',title:'排版子智能体',agent:{userId:'child-agent'},parentConversationId:'solo'},
 {conversationId:'other',title:'别处的任务',agent:{userId:'other-agent'}},
].map(session=>({...session,projectId:'workspace',harness:'codex',runtime:'acp',agentStatus:'idle'} as SessionpageSessionSummary))
const Controls = observer((props: { sessionId: string; entry: string | null }) => <PhoneSessionSidebarControls sidebar={usePhoneSessionSidebar(props)} />)
const Conversation = observer((props: {sessionId: string; entry: string | null}) => {
 const sidebar = usePhoneSessionSidebar(props)
 return <AgentWatchScreen title="验收任务" testId="existing-review" bodyFill><SessionConversation
  timeline={emptyAgentWatchTimeline()} deviceId="qa-device" sessionId={props.sessionId} agentName="Codex" harness="codex" nativeRecord sessionRuntime="acp"
  respondingItemId={null} onRespond={vi.fn()} onSend={actions.send} pendingSends={[]} sending={false} agentWorking={false} onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()}
  composerControls={sidebar.anchor ? (modelControl, model, skillDraft) => <PhoneSessionSidebarControls sidebar={sidebar} modelControl={modelControl} model={model} skillDraft={skillDraft} /> : undefined}
 /></AgentWatchScreen>
})
async function mount(sessionId:string,entry:string|null,full=false){
 followRendererSession('SIGNED_IN', 'owner')
 await page.viewport(390,844);document.documentElement.dataset.theme='dark';document.documentElement.setAttribute('data-phone-shell','');setLocalePreference('zh-CN')
 const chats=[chat({id:'room',kind:'group',name:'手机验收群'}),chat({id:'solo-chat',kind:'dm',peer_user_id:'solo-agent',name:'独立智能体'})]
 publishChatSummaries(chats);dispose=installOwnedAgentEntry({open:()=>false,owns:()=>true})
 publishDirectoryDevices([device('qa-device',[],{is_online:true})]);updateDeviceSessions('qa-device',{projects:[{id:'workspace',name:'Tasks',path:'',kind:'workspace'}],sessions,cached:false,loading:false,error:null})
 harness=createReactHarness();Object.assign(harness.container.style,{position:'fixed',inset:'0',display:'flex',flexDirection:'column',justifyContent:'flex-end',padding:'16px'})
 await renderWithAppProviders(harness,<LocalizationProvider><SessionUiTheme theme="dark"><>{full ? <Conversation sessionId={sessionId} entry={entry}/> : <><Controls sessionId={sessionId} entry={entry}/><PhoneComposerControlRow><span>输入消息</span></PhoneComposerControlRow></>}</></SessionUiTheme></LocalizationProvider>,{auth:{id:'owner'},chat:{chats},contacts:{contacts:[]}})
}
afterEach(()=>{actions.pickModel.mockClear();actions.send.mockClear();actions.reloadTopics.mockClear();actions.topicError=null;harness?.cleanup();dispose?.();removeDeviceSessions('qa-device');publishDirectoryDevices([]);accountProjectsStore.clear();document.documentElement.removeAttribute('data-phone-shell')})
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

it('a group session puts Create agent before its resident Agents and preserves the group destination',async()=>{
 await mount('room-task','chat:room')
 await page.getByTestId('phone-room-agents').click()
 const list=document.querySelector('[data-testid="phone-room-controls-sheet"] .gg-phone-composer-sheet-list')!
 expect(list.firstElementChild?.getAttribute('data-testid')).toBe('phone-create-agent')
 const create=vi.fn();window.addEventListener(UI_EVENTS.createAgentInGroup,create)
 try {await page.getByTestId('phone-create-agent').click();expect((create.mock.calls[0]![0] as CustomEvent).detail).toEqual({chatId:'room'})}
 finally {window.removeEventListener(UI_EVENTS.createAgentInGroup,create)}
})

it('a project session puts Create agent first in Work instead of duplicating it in Agents',async()=>{
 await mount('room-task','chat:room',true)
 // Signing into the fixture legitimately resets account-owned stores first.
 runInAction(()=>{accountProjectsStore.list=[{chatId:'room',name:'Project',archived:false,activeAt:'2026-01-01T00:00:00.000Z',bindings:[{deviceId:'qa-device',localProjectId:'workspace'}]}]})
 await until('project context loaded',()=>!!document.querySelector('[data-anchor-kind="project"]'))
 await page.getByTestId('agent-watch-create-model-device').click()
 const list=document.querySelector('[data-testid="agent-watch-create-controls-sheet"] .gg-phone-composer-sheet-list')!
 expect(list.firstElementChild?.getAttribute('data-testid')).toBe('phone-create-agent')
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 await until('Work closes',()=>!document.querySelector('[data-testid="agent-watch-create-controls-sheet"]'))
 await page.getByTestId('phone-room-agents').click()
 expect(document.querySelector('[data-testid="phone-room-controls-sheet"] [data-testid="phone-create-agent"]')).toBeNull()
})
it('an unrelated task has neither control',async()=>{
 await mount('other','chat:room');expect(document.querySelector('[data-testid="phone-session-sidebar-controls"]')).toBeNull()
})


it.each(['room-task', 'solo'])('%s: Work fixes the device and Agent while model selection uses the existing action', async sessionId => {
 await mount(sessionId,sessionId === 'room-task' ? 'chat:room' : null,true)
 await page.getByTestId('agent-watch-create-model-device').click()
 const panel = document.querySelector('[data-testid="agent-watch-create-controls-sheet"]')!
 expect(panel.querySelectorAll('[data-testid="agent-watch-create-readonly"]')).toHaveLength(2)
 expect(panel.querySelector('[data-dimension="machine"] button')).toBeNull()
 expect(harness!.container.querySelector('[data-composer-locked-agent]')).toBeNull()
 expect(harness!.container.querySelector('[data-testid="composer-model-trigger"]')).toBeNull()
 await page.getByTestId('agent-watch-create-options-drill').click()
 await page.getByRole('radio', {name:'咕咕 GPT-6 Luna',exact:true}).click()
 expect(actions.pickModel).toHaveBeenCalledWith('luna')
})

it.each(['room-task', 'solo'])('%s: the shared row fades and returns with no composer movement', async sessionId => {
 await mount(sessionId,sessionId === 'room-task' ? 'chat:room' : null,true)
 const row = harness!.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
 const input = harness!.container.querySelector<HTMLElement>('[data-slot="composer-input"]')!
 const editor = input.querySelector<HTMLElement>('[contenteditable]')!
 const top = input.getBoundingClientRect().top
 expect(input.getBoundingClientRect().top - row.getBoundingClientRect().bottom).toBe(4)
 editor.focus()
 await until('existing controls fade', () => row.hasAttribute('data-editing'))
 await Promise.all(row.getAnimations().map(a=>a.finished))
 expect(getComputedStyle(row).opacity).toBe('0')
 expect(row.inert).toBe(true)
 expect(input.getBoundingClientRect().top).toBe(top)
 editor.blur()
 await until('existing controls return',()=>!row.hasAttribute('data-editing'))
 await Promise.all(row.getAnimations().map(a=>a.finished))
 expect(getComputedStyle(row).opacity).toBe('1')
 expect(input.getBoundingClientRect().top).toBe(top)
})

it('the selected native skill is visible inside the input and accompanies the actual message', async()=>{
 await mount('room-task','chat:room',true)
 await page.getByTestId('agent-watch-create-skills').click()
 await page.getByRole('checkbox',{name:/代码检查/}).click()
 await expect.element(page.getByTestId('agent-watch-create-skill-tags')).toBeVisible()
 const editor=harness!.container.querySelector<HTMLElement>('[contenteditable]')!
 await page.elementLocator(editor).fill('检查这一段')
 await page.getByRole('button',{name:'发送消息',exact:true}).click()
 await until('actual message sent',()=>actions.send.mock.calls.length===1)
 expect(actions.send.mock.calls[0]![0]).toContain('请使用以下技能：代码检查。')
 expect(actions.send.mock.calls[0]![0]).toContain('检查这一段')
})


it.each([null, '话题读取失败'])('an unread topic list stays explicit and retryable: %s', async error=>{
 actions.topicError=error
 await mount('room-task','chat:room',true)
 await page.getByTestId('phone-room-topics').click()
 const panel=document.querySelector('[data-testid="phone-room-controls-sheet"]')!
 expect(panel.textContent).toContain(error ?? '正在读取话题')
 if(error){await page.getByRole('button',{name:'重试',exact:true}).click();expect(actions.reloadTopics).toHaveBeenCalledOnce()}
})
