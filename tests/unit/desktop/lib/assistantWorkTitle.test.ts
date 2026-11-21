import {expect,it} from 'vitest'
import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
import type {Device} from '@gugu/core/shared/types/chat'
import {assistantWorkTitleOf} from '../../../../apps/desktop/src/lib/assistantWorkTitle'

const work={owner_user_id:'owner',title:'任务',executors:[{device_id:'mac',session_id:'task'}]} as AssistantWorkTask
const devices=[{device_id:'mac',session_digest:[{conversationId:'task',title:'复测回复「收到，测试正文」'}]}] as Device[]
it('recovers an old placeholder from the exact same-account device and session without changing stored facts',()=>{
  expect(assistantWorkTitleOf(work,'owner',devices)).toBe('复测回复「收到，测试正文」')
  expect(work.title).toBe('任务')
})
it('keeps named work, unknown tasks and foreign or ambiguous entries as they are',()=>{
  expect(assistantWorkTitleOf({...work,title:'交付报告'},'owner',devices)).toBe('交付报告')
  expect(assistantWorkTitleOf({...work,owner_user_id:'someone-else'},'owner',devices)).toBe('任务')
  expect(assistantWorkTitleOf(work,'owner',[{...devices[0]!,device_id:'another'}])).toBe('任务')
  expect(assistantWorkTitleOf(work,'owner',[])).toBe('任务')
  const ambiguous=[{...devices[0]!,session_digest:[...devices[0]!.session_digest!,...devices[0]!.session_digest!]}]
  expect(assistantWorkTitleOf(work,'owner',ambiguous)).toBe('任务')
  const malformed=[{...devices[0]!,session_digest:{unreadable:true}}] as unknown as Device[]
  expect(assistantWorkTitleOf(work,'owner',malformed)).toBe('任务')
})
// CODE-REVIEW-1 R1 / S3: a placeholder title is not drawn as 「任务」 before its evidence is known.
it('is not known yet while the devices are not read, or the executor\'s row was carried without its digest',()=>{
  expect(assistantWorkTitleOf(work,'owner',null)).toBeNull()
  const carried=[{device_id:'mac'}] as Device[]
  expect(assistantWorkTitleOf(work,'owner',carried)).toBeNull()
  // A named work needs no evidence.
  expect(assistantWorkTitleOf({...work,title:'交付报告'},'owner',null)).toBe('交付报告')
})
