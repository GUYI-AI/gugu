// @vitest-environment jsdom
import { act } from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { createReactHarness,renderWithAppProviders } from '../../../support/testHarness'
import { rememberAssistantTaskChat,showAssistantTaskChat } from '../../../../apps/desktop/src/lib/assistantTaskChat'
import { useTaskChatRows } from '../../../../apps/desktop/src/components/assistant/useTaskChatRows'
import { followRendererSession,queryClient } from '../../../../apps/desktop/src/lib/replica'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { WORK_RETRY_MS } from '../../../../apps/desktop/src/components/assistant/assistant-work-records'

const cloud = vi.hoisted(() => ({ history: vi.fn(),list:vi.fn(),watch: vi.fn(),refresh: null as null | (() => void) }))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',() => ({ assistantWorkCloud: { historyAll: cloud.history,listAll:cloud.list,
  // One work and its events (the window and the chat rows share this read); its events are the history.
  get: async (assistant: string,workId: string) => ({ work: { work_id: workId },events: await cloud.history(assistant,workId) }) },
  watchAssistantWork: (_owner: string,_assistant: string,refresh: () => void) => { cloud.refresh=refresh; cloud.watch(); return () => {} } }))
vi.mock('../../../../apps/desktop/src/store/devicesContext',() => ({ useDevicesStore: () => { throw new Error('Task history must not query devices') } }))
let harness: ReturnType<typeof createReactHarness>
const request = (workId: string) => ({ workId,assistantId: 'assistant',taskAgentId: 'executor',task: { deviceId: 'offline',sessionId: 'worker' },assistants: [{ deviceId: 'offline-home',sessionId: 'home' }] })
const event = (workId: string,content: string) => ({ work_id: workId,message_id: workId,seq: '1',from_session_id: 'home',to_session_id: 'worker',
  content,source_available: true,source_message_id: null,attachment_refs: [],platform_received_at: '2026-10-26T08:00:00Z' })
function View() { const { rows,notice } = useTaskChatRows([],'owner','executor',true); return <>{notice}<p>{rows.map(row=>row.message.content).join(',')}</p></> }
beforeEach(() => { queryClient.clear(); followRendererSession('SIGNED_IN','owner'); harness=createReactHarness(); cloud.history.mockReset(); cloud.list.mockReset(); cloud.watch.mockClear(); cloud.refresh=null; showAssistantTaskChat(null) })
afterEach(() => { harness.cleanup(); showAssistantTaskChat(null) })
it('reads cloud collaboration with every device offline and has no device retry or sync notice',async () => {
  cloud.history.mockResolvedValue([event('work-a','Cloud result')])
  rememberAssistantTaskChat('owner',request('work-a'));showAssistantTaskChat({ownerId:'owner',request:request('work-a'),name:'worker'})
  await renderWithAppProviders(harness,<View />)
  await vi.waitFor(()=>expect(harness.container.textContent).toContain('Cloud result'))
  expect(cloud.history).toHaveBeenCalledWith('assistant','work-a')
  expect(harness.container.querySelector('[data-testid="task-collaboration-retry"]')).toBeNull()
  cloud.history.mockRejectedValue(new Error('Account API offline'))
  await act(async () => cloud.refresh?.())
  expect(harness.container.textContent).toContain('Cloud result')
  expect(harness.container.textContent).toContain('暂时无法读取完整的协作记录')
  expect(harness.container.querySelector('button')).toBeNull()
})
it('selects distinct work for the same executor and replaces removed source content on reread',async () => {
  cloud.history.mockImplementation(async (_a: string,w: string) => [event(w,w)])
  rememberAssistantTaskChat('owner',request('work-a'));showAssistantTaskChat({ownerId:'owner',request:request('work-a'),name:'worker'})
  await renderWithAppProviders(harness,<View />)
  await act(async()=> { rememberAssistantTaskChat('owner',request('work-b')); showAssistantTaskChat({ ownerId: 'owner',request: request('work-b'),name: 'worker' }) })
  await vi.waitFor(()=>expect(harness.container.textContent).toContain('work-b'))
  expect(harness.container.textContent).not.toContain('work-a')
  cloud.history.mockResolvedValue([{ ...event('work-b','removed'),source_available: false,content: null }])
  await act(async()=>cloud.refresh?.())
  await vi.waitFor(()=>expect(harness.container.textContent).not.toContain('work-b'))
})
it('recovers a transient account read in the background without a retry button',async()=>{
  cloud.history.mockRejectedValueOnce(new Error('Transient account connection')).mockResolvedValue([event('work-retry','Recovered cloud history')])
  rememberAssistantTaskChat('owner',request('work-retry'));showAssistantTaskChat({ownerId:'owner',request:request('work-retry'),name:'worker'})
  // The background retry waits WORK_RETRY_MS[0] (2 s); that wait is not what is proven, so it runs on a fake clock.
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
  try{
    await renderWithAppProviders(harness,<View />)
    await act(async()=>{await vi.advanceTimersByTimeAsync(0)})
    await vi.waitFor(()=>expect(harness.container.textContent).toContain('暂时无法读取完整的协作记录'))
    expect(cloud.history).toHaveBeenCalledTimes(1)
    await act(async()=>{await vi.advanceTimersByTimeAsync(WORK_RETRY_MS[0])})
    await vi.waitFor(()=>expect(harness.container.textContent).toContain('Recovered cloud history'))
    expect(harness.container.querySelector('button')).toBeNull()
    expect(harness.container.textContent).not.toContain('暂时无法读取完整的协作记录')
  }finally{vi.useRealTimers()}
})

it('coalesces changes during a history read into one following refresh',async()=>{
  let finish!:(events:unknown[])=>void
  cloud.history.mockReturnValueOnce(new Promise(resolve=>{finish=resolve})).mockResolvedValue([event('work-burst','Newest')])
  rememberAssistantTaskChat('owner',request('work-burst'))
  showAssistantTaskChat({ownerId:'owner',request:request('work-burst'),name:'worker'})
  await renderWithAppProviders(harness,<View />)
  await act(async()=>{for(let n=0;n<20;n++)cloud.refresh?.()})
  expect(cloud.history).toHaveBeenCalledTimes(1)
  await act(async()=>finish([event('work-burst','First')]))
  await vi.waitFor(()=>expect(harness.container.textContent).toContain('Newest'))
  expect(cloud.history).toHaveBeenCalledTimes(2)
})

it('resolves a pre-ledger task link from account assignments without contacting its old device',async()=>{
  cloud.list.mockResolvedValue([{work_id:'legacy-work',coordinator_session_id:'home',coordinator_device_id:'offline-home',executors:[{session_id:'worker',device_id:'offline'}]},
    {work_id:'other-work',coordinator_session_id:'other-home',coordinator_device_id:'offline-home',executors:[{session_id:'worker',device_id:'offline'}]}])
  cloud.history.mockResolvedValue([event('legacy-work','Original phone collaboration')])
  const legacy={...request('unused'),workId:undefined}
  rememberAssistantTaskChat('owner',legacy);showAssistantTaskChat({ownerId:'owner',request:legacy,name:'worker'})
  await renderWithAppProviders(harness,<View />)
  await vi.waitFor(()=>expect(harness.container.textContent).toContain('Original phone collaboration'))
  expect(cloud.list).toHaveBeenCalledWith('assistant')
  expect(cloud.history).toHaveBeenCalledWith('assistant','legacy-work')
  expect(cloud.history).not.toHaveBeenCalledWith('assistant','other-work')
})

it('a ledger read before whose read again fails keeps the rows and says the collaboration record is incomplete', async () => {
  const work = { work_id: 'work-l', coordinator_session_id: 'home', coordinator_device_id: 'offline-home', executors: [{ session_id: 'worker', device_id: 'offline' }] }
  cloud.list.mockResolvedValue([work])
  cloud.history.mockResolvedValue([event('work-l', 'Ledger result')])
  const ledgerRequest = { ...request('work-l'), workId: undefined }
  rememberAssistantTaskChat('owner', ledgerRequest as never); showAssistantTaskChat({ ownerId: 'owner', request: ledgerRequest as never, name: 'worker' })
  await renderWithAppProviders(harness, <View />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('Ledger result'))
  expect(harness.container.textContent).not.toContain('暂时无法读取完整的协作记录')
  cloud.list.mockRejectedValue(new Error('Account API offline'))
  const { assistantWorkRecords } = await import('../../../../apps/desktop/src/components/assistant/assistant-work-records')
  await act(async () => { await assistantWorkRecords.refresh('assistant').catch(() => undefined) })
  await vi.waitFor(() => expect(harness.container.textContent).toContain('暂时无法读取完整的协作记录'))
  expect(harness.container.textContent).toContain('Ledger result')
})
