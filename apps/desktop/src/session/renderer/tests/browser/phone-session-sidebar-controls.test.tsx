import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { observer } from 'mobx-react-lite'
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
import { OPEN_LINK_TARGET, type LinkNavigation } from '@/lib/guguLinks'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { chat, device, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

const actions = vi.hoisted(() => ({ pickModel: vi.fn(), send: vi.fn(), reloadTopics: vi.fn(), topics: null as TopicSummary[] | null, topicError: null as string | null }))
vi.mock('@/hooks/useTopics', async original => ({ ...(await original<object>()), useTopicsOfChat: () => ({ topics: actions.topics, loading: actions.topics === null && actions.topicError === null, error: actions.topicError, reload: actions.reloadTopics }) }))
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
const Controls = observer((props: { sessionId: string; entry: string | null; deviceId?: string }) => <PhoneSessionSidebarControls sidebar={usePhoneSessionSidebar(props)} conversationKey={`${props.deviceId ?? 'qa-device'}:${props.sessionId}`} />)
const Conversation = observer((props: {sessionId: string; entry: string | null; deviceId?: string}) => {
 const sidebar = usePhoneSessionSidebar(props)
 return <AgentWatchScreen title="验收任务" testId="existing-review" bodyFill><SessionConversation
  timeline={emptyAgentWatchTimeline()} deviceId={props.deviceId ?? 'qa-device'} sessionId={props.sessionId} agentName="Codex" harness="codex" nativeRecord sessionRuntime="acp"
  respondingItemId={null} onRespond={vi.fn()} onSend={actions.send} pendingSends={[]} sending={false} agentWorking={false} onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()}
  composerControls={(modelControl, model, skillDraft) => <PhoneSessionSidebarControls sidebar={sidebar} conversationKey={`${props.deviceId ?? 'qa-device'}:${props.sessionId}`} modelControl={modelControl} model={model} skillDraft={skillDraft} />}
 /></AgentWatchScreen>
})
async function mount(sessionId:string,entry:string|null,full=false,width=390,theme:'light'|'dark'='dark',locale:'zh-CN'|'en-US'='zh-CN'){
 followRendererSession('SIGNED_IN', 'owner')
 await page.viewport(width,844);document.documentElement.dataset.theme=theme;document.documentElement.setAttribute('data-phone-shell','');setLocalePreference(locale)
 const chats=[chat({id:'room',kind:'group',name:'手机验收群'}),chat({id:'solo-chat',kind:'dm',peer_user_id:'solo-agent',name:'独立智能体'})]
 publishChatSummaries(chats);dispose=installOwnedAgentEntry({open:()=>false,owns:()=>true})
 publishDirectoryDevices([device('qa-device',[],{is_online:true})]);updateDeviceSessions('qa-device',{projects:[{id:'workspace',name:'Tasks',path:'',kind:'workspace'}],sessions,cached:false,loading:false,error:null})
 // The production full screen already supplies its body inset; only isolated controls need a fixture inset.
 harness=createReactHarness();Object.assign(harness.container.style,{position:'fixed',inset:'0',display:'flex',flexDirection:'column',justifyContent:'flex-end',padding:full?'0':'16px'})
 await renderWithAppProviders(harness,<LocalizationProvider><SessionUiTheme theme={theme}><>{full ? <Conversation sessionId={sessionId} entry={entry}/> : <><Controls sessionId={sessionId} entry={entry}/><PhoneComposerControlRow><span>输入消息</span></PhoneComposerControlRow></>}</></SessionUiTheme></LocalizationProvider>,{auth:{id:'owner'},chat:{chats},contacts:{contacts:[]}})
}
afterEach(()=>{actions.pickModel.mockClear();actions.send.mockClear();actions.reloadTopics.mockClear();actions.topics=null;actions.topicError=null;harness?.cleanup();dispose?.();removeDeviceSessions('qa-device');publishDirectoryDevices([]);document.documentElement.removeAttribute('data-phone-shell')})
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
it('an existing room task opens its short Topics menu and dispatches the actual topic id',async()=>{
 const topic:TopicSummary={chat_id:'long-room-topic',name:'这是一个必须在菜单里完整显示而不是铺到输入框菜单栏里的话题名称',source_message_id:'topic-anchor',creator_user_id:'owner',last_message_at:null,message_count:3,participant_count:2,is_participant:true}
 actions.topics=[topic]
 await mount('room-task','chat:room',true)
 await vi.waitFor(()=>{
  const button=harness!.container.querySelector<HTMLElement>('[data-testid="phone-room-topics"]')
  expect(button,harness!.container.innerHTML).not.toBeNull()
  expect(button!.getBoundingClientRect().width).toBeGreaterThan(0)
  expect(button!.getBoundingClientRect().height).toBeGreaterThan(0)
 },{timeout:10000})
 const trigger=harness!.container.querySelector<HTMLButtonElement>('[data-testid="phone-room-topics"]')!
 expect(trigger.textContent).toBe('话题')
 expect(trigger.getAttribute('aria-expanded')).toBe('false')
 expect(trigger.querySelectorAll('svg')).toHaveLength(1)
 const box=trigger.getBoundingClientRect(),icon=trigger.querySelector('svg')!.getBoundingClientRect()
 await page.elementLocator(trigger).click({position:{x:icon.left+icon.width/2-box.left,y:icon.top+icon.height/2-box.top}})
 await vi.waitFor(()=>{
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(document.querySelector('[data-testid="phone-room-controls-sheet"] .gg-phone-room-topic-name')?.textContent).toBe(topic.name)
 },{timeout:10000})
 const panel=document.querySelector<HTMLElement>('[data-testid="phone-room-controls-sheet"]')!
 const name=panel.querySelector<HTMLElement>('.gg-phone-room-topic-name')!
 expect(name.textContent).toBe(topic.name)
 expect(getComputedStyle(name).whiteSpace).toBe('normal')
 expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth)
 const opened: LinkNavigation['target'][]=[]
 const capture=(event:Event)=>{
  event.preventDefault()
  const detail=(event as CustomEvent<LinkNavigation>).detail
  opened.push(detail.target)
  detail.resolve()
 }
 window.addEventListener(OPEN_LINK_TARGET,capture)
 try {
  await page.getByRole('button',{name:topic.name,exact:true}).click()
  await vi.waitFor(()=>expect(opened).toEqual([{kind:'chat',chatId:topic.chat_id}]),{timeout:10000})
  await until('topic navigation closes the panel',()=>document.querySelector('[data-testid="phone-room-controls-sheet"]')===null)
  await page.getByTestId('phone-room-topics').click()
  await page.getByRole('button',{name:'群聊',exact:true}).click()
  await vi.waitFor(()=>expect(opened).toEqual([{kind:'chat',chatId:topic.chat_id},{kind:'chat',chatId:'room'}]),{timeout:10000})
 } finally { window.removeEventListener(OPEN_LINK_TARGET,capture) }
})

it.each([360,390].flatMap(width=>(['light','dark'] as const).map(theme=>({width,theme}))))('$width/$theme: the real four-control row fits with one topic dropdown icon',async({width,theme})=>{
 await mount('room-task','chat:room',true,width,theme)
 await vi.waitFor(()=>{
  const controls=harness!.container.querySelectorAll<HTMLElement>('[data-phone-composer-controls] .gg-phone-composer-control')
  expect(controls).toHaveLength(4)
  for(const button of controls){
   expect(button.getBoundingClientRect().width,button.outerHTML).toBeGreaterThan(0)
   expect(button.getBoundingClientRect().height,button.outerHTML).toBeGreaterThan(0)
  }
 },{timeout:10000})
 await document.fonts.ready
 const row=harness!.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
 const buttons=[...row.querySelectorAll<HTMLElement>('.gg-phone-composer-control')]
 expect(buttons.map(button=>button.textContent)).toEqual(['工作','技能','话题','智能体'])
 expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
 for(const [index,button] of buttons.entries()){
  const box=button.getBoundingClientRect(),style=getComputedStyle(button)
  expect(box.y).toBe(buttons[0]!.getBoundingClientRect().y)
  expect(box.right).toBeLessThanOrEqual(width-16)
  expect([style.paddingLeft,style.paddingRight]).toEqual(['12px','12px'])
  if(index)expect(box.left-buttons[index-1]!.getBoundingClientRect().right).toBe(8)
  const label=button.querySelector<HTMLElement>('.gg-phone-composer-control-label')!
  expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth)
 }
 const topic=buttons[2]!,label=topic.querySelector<HTMLElement>('.gg-phone-composer-control-label')!,icon=topic.querySelector('svg')!
 expect(topic.querySelectorAll('svg')).toHaveLength(1)
 expect(icon.getBoundingClientRect().left-label.getBoundingClientRect().right).toBe(4)
 expect(topic.getBoundingClientRect().right-icon.getBoundingClientRect().right).toBe(12)
})
it.each([320,360].flatMap(width=>[14,21].map(fontSize=>({width,fontSize}))))('$width/English/$fontSize: every fixed-size control remains reachable without widening the page',async({width,fontSize})=>{
 await mount('room-task','chat:room',true,width,'dark','en-US')
 harness!.container.style.setProperty('--font-body',`${fontSize}px`)
 harness!.container.style.fontFamily='Arial, sans-serif'
 await document.fonts.ready
 const row=()=>harness!.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
 await vi.waitFor(()=>{
  const buttons=row().querySelectorAll<HTMLElement>('.gg-phone-composer-control')
  expect(buttons).toHaveLength(4)
  for(const button of buttons) expect(button.getBoundingClientRect().width,button.outerHTML).toBeGreaterThan(0)
 },{timeout:10000})
 const items=row().querySelector<HTMLElement>('.gg-phone-composer-controls-items')!
 const buttons=[...items.querySelectorAll<HTMLElement>('.gg-phone-composer-control')]
 const toggle=row().querySelector<HTMLElement>('[data-testid="phone-composer-menu-toggle"]')!
 expect(buttons.map(button=>button.textContent)).toEqual(['Work','Skills','Topics','Agents'])
 expect(getComputedStyle(items).overflowX).toBe('auto')
 expect(items.scrollWidth).toBeGreaterThan(items.clientWidth)
 expect(items.getBoundingClientRect().right).toBeLessThanOrEqual(width-16)
 expect(toggle.getBoundingClientRect().bottom).toBeLessThanOrEqual(items.getBoundingClientRect().top)
 expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
 for(const [index,button] of buttons.entries()){
  const box=button.getBoundingClientRect(),style=getComputedStyle(button)
  expect(box.top).toBe(buttons[0]!.getBoundingClientRect().top)
  expect(box.height).toBe(44)
  expect([style.paddingLeft,style.paddingRight]).toEqual(['12px','12px'])
  expect(style.fontSize).toBe(`${fontSize}px`)
  if(index)expect(box.left-buttons[index-1]!.getBoundingClientRect().right).toBe(8)
 }
 items.scrollLeft=items.scrollWidth
 const last=buttons.at(-1)!
 await vi.waitFor(()=>{
  expect(items.scrollLeft).toBeGreaterThan(0)
  const visible=items.getBoundingClientRect(),box=last.getBoundingClientRect()
  expect(box.left).toBeGreaterThanOrEqual(visible.left)
  expect(box.right).toBeLessThanOrEqual(visible.right)
  expect(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.closest('button')).toBe(last)
 })
 await page.elementLocator(last).click()
 await expect.element(page.getByTestId('phone-sidebar-agent')).toHaveTextContent('群里的验收任务')
 expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
})

it.each((['session','device'] as const).flatMap(change=>(['collapsed','expanded'] as const).map(choice=>({change,choice}))))('$change/$choice: directory empty/full/empty preserves the manual choice until the actual identity changes',async({change,choice})=>{
 await mount('room-task','chat:room',true)
 await act(async()=>{removeDeviceSessions('qa-device')})
 const row=()=>harness!.container.querySelector<HTMLElement>('[data-phone-composer-controls]')!
 await vi.waitFor(()=>expect(row().querySelector('[data-testid="agent-watch-create-model-device"]')).not.toBeNull())
 const original=row()
 const collapsed=choice==='collapsed'
 if(!collapsed){
  const editor=harness!.container.querySelector<HTMLElement & {editor:{commands:{setContent:(html:string)=>void}}}>('[contenteditable]')!
  editor.editor.commands.setContent('<p>Keep this draft</p>')
  await vi.waitFor(()=>expect(original.hasAttribute('data-collapsed')).toBe(true))
 }
 await page.getByTestId('phone-composer-menu-toggle').click()
 await vi.waitFor(()=>expect(original.hasAttribute('data-collapsed')).toBe(collapsed))
 await act(async()=>{updateDeviceSessions('qa-device',{projects:[{id:'workspace',name:'Tasks',path:'',kind:'workspace'}],sessions,cached:false,loading:false,error:null})})
 await vi.waitFor(()=>{
  expect(harness!.container.querySelector('[data-testid="agent-watch-create-skills"]')).not.toBeNull()
  expect(row()).toBe(original)
  expect(row().hasAttribute('data-collapsed')).toBe(collapsed)
  expect(row().querySelector('[data-testid="phone-composer-menu-toggle"]')?.getAttribute('aria-expanded')).toBe(String(!collapsed))
 })
 await act(async()=>{removeDeviceSessions('qa-device')})
 await vi.waitFor(()=>{
  expect(harness!.container.querySelector('[data-testid="agent-watch-create-skills"]')).toBeNull()
  expect(row()).toBe(original)
  expect(row().hasAttribute('data-collapsed')).toBe(collapsed)
  expect(row().querySelector('[data-testid="phone-composer-menu-toggle"]')?.getAttribute('aria-expanded')).toBe(String(!collapsed))
  expect(row().querySelector<HTMLElement>('.gg-phone-composer-controls-items')!.getBoundingClientRect().height).toBe(collapsed?0:44)
 })
 await renderWithAppProviders(harness!,<LocalizationProvider><SessionUiTheme theme="dark"><><Conversation sessionId={change==='session'?'other':'room-task'} deviceId={change==='device'?'qa-other-device':'qa-device'} entry={null}/></></SessionUiTheme></LocalizationProvider>,{auth:{id:'owner'},contacts:{contacts:[]}})
 await vi.waitFor(()=>{
  expect(row()).not.toBe(original)
  expect(row().hasAttribute('data-collapsed')).toBe(false)
  expect(row().querySelector('[data-testid="phone-composer-menu-toggle"]')?.getAttribute('aria-expanded')).toBe('true')
 })
})

it('an unrelated task does not inherit room navigation',async()=>{
 await mount('other','chat:room');expect(document.querySelector('[data-testid="phone-room-topics"]')).toBeNull();expect(document.querySelector('[data-testid="phone-room-agents"]')).toBeNull()
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
  expect(row.getBoundingClientRect().height).toBe(0)
  expect(getComputedStyle(row).marginBottom).toBe('0px')
  expect(getComputedStyle(row).paddingTop).toBe('0px')
  expect(getComputedStyle(row).paddingBottom).toBe('0px')
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

it('a childless Agent keeps actual Work and Skills without Topics or Agents', async()=>{
 await mount('other',null,true)
 await expect.element(page.getByTestId('agent-watch-create-model-device')).toBeVisible()
 await expect.element(page.getByTestId('agent-watch-create-skills')).toBeVisible()
 expect(document.querySelector('[data-testid="phone-room-topics"]')).toBeNull()
 expect(document.querySelector('[data-testid="phone-room-agents"]')).toBeNull()
})
