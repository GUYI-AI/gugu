// @vitest-environment jsdom
import { act } from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useIntegrationAccounts } from '../../../../apps/desktop/src/session/renderer/features/integrations/use-integration-accounts'
const fixture=vi.hoisted(()=>({ accounts:vi.fn(),checks:vi.fn() }))
const host=vi.hoisted(()=>({run:0,value:null as null|{key:string}}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host',()=>({isTooOld:()=>false,useLibraryHost:()=>host.value,keepLibraryHost:(h:unknown)=>h,libraryHostOf:()=>host.value,peekLibraryHost:()=>host.value}))
let h:ReturnType<typeof createReactHarness>
// A fresh host key per case: the replica entries outlive a test.
beforeEach(()=>{vi.useFakeTimers();h=createReactHarness();host.run+=1;host.value={key:`cloud-${host.run}`,assistantPanel:{},assistantPanelExpected:true,integrations:{accounts:fixture.accounts,checkAccounts:fixture.checks}} as never;fixture.accounts.mockReset();fixture.checks.mockReset()})
afterEach(()=>{h.cleanup();vi.useRealTimers()})
it.each(['accounts','checks'] as const)('never retries a fixed snapshot failure in %s',async which=>{
  fixture.accounts.mockResolvedValue([{accountId:'a'}]);fixture.checks.mockResolvedValue([])
  fixture[which].mockRejectedValue(Object.assign(new Error('snapshot'),{code:'collection-unavailable'}))
  function Probe(){useIntegrationAccounts('mail',true);return null}
  await h.render(<Probe/>)
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000)})
  expect(fixture[which]).toHaveBeenCalledTimes(1)
})
