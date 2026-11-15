// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { platform } from '../../../support/capacitorPlatformTestDouble'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform',()=>import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/chat',()=>import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus',()=>import('../../../support/agentDisplayStatusTestDouble'))

let ui: ReturnType<typeof createReactHarness>
let previousScan: boolean
beforeEach(()=>{ui=createReactHarness();previousScan=platform.capabilities.barcodeScan;platform.capabilities.barcodeScan=true})
afterEach(()=>{ui.cleanup();platform.capabilities.barcodeScan=previousScan})
const find=(id:string)=>document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

it('phone: the pen opens creation directly, before the separate rightmost More button',async()=>{
 const create=vi.fn(),project=vi.fn(),scan=vi.fn()
 await renderWithAppProviders(ui,createNode(ChatListPanel,{mobile:true,onOpenSessionCreate:create,onNewProject:project,onScan:scan}),{auth:{id:'owner'},chat:{chats:[]}})
 const pen=find(AUTOMATION_TEST_IDS.mobileSessionCreateAction)!,more=find(AUTOMATION_TEST_IDS.chatListPlusButton)!
 expect(pen.compareDocumentPosition(more)&Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
 await clickElement(pen)
 expect(create).toHaveBeenCalledOnce()
 expect(find('plus-menu-create-group')).toBeNull()
 await clickElement(more)
 await vi.waitFor(()=>expect(find('plus-menu-new-project')).not.toBeNull())
 expect([...document.querySelectorAll('[role="menuitem"]')].map(e=>e.getAttribute('data-testid'))).toEqual(['plus-menu-create-group','plus-menu-new-project','plus-menu-add-friend','plus-menu-scan'])
 await clickElement(find('plus-menu-new-project')!)
 expect(project).toHaveBeenCalledOnce()
 expect(create).toHaveBeenCalledOnce()
})

it('desktop: creation stays in the existing menu rather than gaining a new pen button',async()=>{
 const create=vi.fn()
 await renderWithAppProviders(ui,createNode(ChatListPanel,{mobile:false,onOpenSessionCreate:create}),{auth:{id:'owner'},chat:{chats:[]}})
 expect(find(AUTOMATION_TEST_IDS.mobileSessionCreateAction)).toBeNull()
 await clickElement(find(AUTOMATION_TEST_IDS.chatListPlusButton)!)
 await vi.waitFor(()=>expect(find(AUTOMATION_TEST_IDS.mobileSessionCreateAction)).not.toBeNull())
 await clickElement(find(AUTOMATION_TEST_IDS.mobileSessionCreateAction)!)
 expect(create).toHaveBeenCalledOnce()
})
