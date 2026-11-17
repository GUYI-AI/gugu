import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { observer } from 'mobx-react-lite'
import { ThemeProvider } from '@/store/theme'
import { writeThemePreference } from '@renderer/lib/theme/host-theme'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMobileWorkspaceCatalog'
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
const Controls = observer((props: { sessionId: string; entry: string | null }) => <PhoneSessionSidebarControls sidebar={usePhoneSessionSidebar(props)} />)
const Conversation = observer((props: {sessionId: string; entry: string | null}) => {
 const sidebar = usePhoneSessionSidebar(props)
 return <AgentWatchScreen title="验收任务" testId="existing-review" bodyFill><SessionConversation
  timeline={emptyAgentWatchTimeline()} deviceId="qa-device" sessionId={props.sessionId} agentName="Codex" harness="codex" nativeRecord sessionRuntime="acp"
  respondingItemId={null} onRespond={vi.fn()} onSend={actions.send} pendingSends={[]} sending={false} agentWorking={false} onStop={vi.fn()} stopping={false} onLoadOlder={vi.fn()}
  composerControls={(modelControl, model, skillDraft) => <PhoneSessionSidebarControls sidebar={sidebar} modelControl={modelControl} model={model} skillDraft={skillDraft} />}
 /></AgentWatchScreen>
})
async function mount(sessionId:string,entry:string|null,full=false,width=390,theme:'light'|'dark'='dark'){
 followRendererSession('SIGNED_IN', 'owner')
 await page.viewport(width,844);writeThemePreference(theme);document.documentElement.dataset.theme=theme;document.documentElement.setAttribute('data-phone-shell','');setLocalePreference('zh-CN')
 const chats=[chat({id:'room',kind:'group',name:'手机验收群'}),chat({id:'solo-chat',kind:'dm',peer_user_id:'solo-agent',name:'独立智能体'})]
 publishChatSummaries(chats);dispose=installOwnedAgentEntry({open:()=>false,owns:()=>true})
 publishDirectoryDevices([device('qa-device',[],{is_online:true})]);updateDeviceSessions('qa-device',{projects:[{id:'workspace',name:'Tasks',path:'',kind:'workspace'}],sessions,cached:false,loading:false,error:null})
 // The production full screen already supplies its body inset; only isolated controls need a fixture inset.
 harness=createReactHarness();harness.container.dataset.taScope='';Object.assign(harness.container.style,{position:'fixed',inset:'0',display:'flex',flexDirection:'column',justifyContent:'flex-end',padding:full?'0':'16px',background:'var(--ta-panel-bg)'})
 await renderWithAppProviders(harness,<ThemeProvider><LocalizationProvider><SessionUiTheme theme={theme}><>{full ? <Conversation sessionId={sessionId} entry={entry}/> : <><Controls sessionId={sessionId} entry={entry}/><PhoneComposerControlRow><span>输入消息</span></PhoneComposerControlRow></>}</></SessionUiTheme></LocalizationProvider></ThemeProvider>,{auth:{id:'owner'},chat:{chats},contacts:{contacts:[]}})
}
afterEach(()=>{actions.pickModel.mockClear();actions.send.mockClear();actions.reloadTopics.mockClear();actions.topics=null;actions.topicError=null;harness?.cleanup();dispose?.();removeDeviceSessions('qa-device');publishDirectoryDevices([]);document.documentElement.removeAttribute('data-phone-shell');document.documentElement.removeAttribute('data-theme')})

// D/E capture only: real pages and production portal remain mounted. The
// account/directory/catalog/transport are controlled; no host or send is run.
const deHost = () => harness!.container
const deRow = () => deHost().querySelector<HTMLElement>('[data-phone-composer-controls]')!
const deWork = () => deHost().querySelector<HTMLButtonElement>('[data-testid="agent-watch-create-model-device"]')!
const dePanel = () => document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet"]')
function assertDirection(open: boolean) {
  const button = deWork()
  expect(button.textContent).toBe('工作')
  expect(button.getAttribute('aria-expanded')).toBe(String(open))
  expect(button.querySelectorAll('svg')).toHaveLength(1)
  expect(button.querySelector('svg[data-phone-menu-direction]')?.getAttribute('data-phone-menu-direction')).toBe(open ? 'down' : 'up')
  expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)
}
async function panelReady() {
  await until('real page popup settled', () => !!dePanel() && getComputedStyle(dePanel()!).opacity === '1')
  await Promise.all(dePanel()!.getAnimations().map(a => a.finished))
  const panel = dePanel()!, close = panel.querySelector<HTMLButtonElement>('[data-testid="agent-watch-create-controls-sheet-close"]')!
  expect(close.getAttribute('aria-label')).toBe('关闭')
  const p = panel.getBoundingClientRect(), c = close.getBoundingClientRect()
  expect(c.height).toBeGreaterThanOrEqual(44); expect(c.width).toBeGreaterThanOrEqual(44)
  expect(c.left).toBeGreaterThanOrEqual(p.left + p.width / 2)
  expect(c.right).toBeLessThanOrEqual(p.right)
  expect(c.top).toBeGreaterThanOrEqual(p.top)
  expect(c.bottom).toBeLessThanOrEqual(p.top + 60)
  assertDirection(true)
}
function assertVisibleRow() {
  const row = deRow(), items = row.querySelector<HTMLElement>('.gg-phone-composer-controls-items')!
  expect(row.hasAttribute('data-editing')).toBe(false); expect(row.inert).toBe(false)
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)
  if (!items.hidden) expect(items.scrollWidth).toBeLessThanOrEqual(items.clientWidth)
  expect(row.getBoundingClientRect().height).toBeGreaterThan(40)
}
function assertDisclosure(expanded: boolean) {
  const row = deRow(), toggle = row.querySelector<HTMLButtonElement>('[data-testid="phone-composer-menu-toggle"]')!
  expect(toggle.getAttribute('aria-expanded')).toBe(String(expanded))
  expect(toggle.getAttribute('aria-label')).toBe(expanded ? '收起输入框菜单栏' : '展开输入框菜单栏')
  const box = toggle.getBoundingClientRect(), pseudo = getComputedStyle(toggle, '::after'), outer = row.getBoundingClientRect()
  const left = box.left + parseFloat(pseudo.left), right = box.right - parseFloat(pseudo.right)
  expect(right - left).toBe(44)
  expect(box.height - parseFloat(pseudo.top) - parseFloat(pseudo.bottom)).toBe(44)
  expect(left).toBeGreaterThanOrEqual(outer.left); expect(right).toBeLessThanOrEqual(outer.right)
  expect(document.elementFromPoint(right - 1, box.top + box.height / 2)?.closest('button')).toBe(toggle)
}
async function deCapture(group: 'D' | 'E', phase: string, width: number, theme: 'light' | 'dark') {
  expect(document.body.textContent).not.toMatch(/agentWatch\.|shell\./)
  assertVisibleRow()
  await page.screenshot({ path: `__screenshots__/owner-phone-regression/${group}-existing-thread-${phase}-${width}-${theme}.png` })
}
for (const width of [360, 390]) for (const theme of ['light', 'dark'] as const) {
  it(`${width}/${theme}: actual existing-thread page shows menu directions, root and model child Close, and retained draft disclosure`, async () => {
    await mount('room-task', 'chat:room', true, width, theme)
    const original = deHost().querySelector<HTMLElement>('[contenteditable]')!
    const engine = (original as HTMLElement & { editor: { commands: { setContent(html: string): void; clearContent(emit: boolean): void } } }).editor
    original.blur()
    await until('real empty menu available', () => !!deWork() && !deRow().hasAttribute('data-editing'))
    await document.fonts.ready
    await until('actual shell theme settled', () => document.documentElement.dataset.theme === theme)
    assertDirection(false); assertDisclosure(true)
    await deCapture('D', 'before-up', width, theme)
    await page.getByTestId('agent-watch-create-model-device').click(); await panelReady()
    expect(dePanel()!.querySelector('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')).not.toBeNull()
    await deCapture('E', 'root-down-close', width, theme)
    await page.elementLocator(dePanel()!.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!).click()
    await until('actual model child rendered', () => !!dePanel()?.querySelector('[data-dimension="model"][data-option-id="glm"]'))
    await panelReady()
    await deCapture('E', 'child-down-close', width, theme)
    await page.getByTestId('agent-watch-create-controls-sheet-close').click()
    await until('actual child Close removes popup', () => dePanel() === null)
    assertDirection(false); expect(deHost().querySelector('[contenteditable]')).toBe(original)
    await deCapture('D', 'child-x-closed-up', width, theme)
    await page.getByTestId('agent-watch-create-model-device').click(); await panelReady()
    await page.getByTestId('agent-watch-create-controls-sheet-close').click()
    await until('actual root Close removes popup', () => dePanel() === null)
    assertDirection(false)
    await deCapture('E', 'root-x-closed-up', width, theme)
    try {
      engine.commands.setContent('<p>关闭菜单仍保留的草稿</p>'); original.blur()
      await until('real draft keeps collapsed disclosure', () => deRow().hasAttribute('data-collapsed') && !deRow().hasAttribute('data-editing'))
      expect(original.textContent).toBe('关闭菜单仍保留的草稿'); assertDisclosure(false)
      await deCapture('D', 'draft-collapsed-row-up', width, theme)
      await page.getByTestId('phone-composer-menu-toggle').click()
      await until('manual disclosure expands real controls', () => !deRow().hasAttribute('data-collapsed'))
      expect(original.textContent).toBe('关闭菜单仍保留的草稿')
      expect(deHost().querySelector('[contenteditable]')).toBe(original)
      assertDirection(false); assertDisclosure(true)
      await deCapture('D', 'draft-expanded-row-down', width, theme)
    } finally { engine.commands.clearContent(true) }
    expect(actions.send).not.toHaveBeenCalled(); expect(actions.pickModel).not.toHaveBeenCalled()
  })
}
