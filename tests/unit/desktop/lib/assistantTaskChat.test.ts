// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest'
import {readAssistantTaskChat,rememberAssistantTaskChat,showAssistantTaskChat} from '../../../../apps/desktop/src/lib/assistantTaskChat'
const task=(workId:string)=>({workId,assistantId:'assistant',taskAgentId:'reused-agent',task:{deviceId:'device',sessionId:'session'},assistants:[{deviceId:'home',sessionId:'home-session'}]})
afterEach(()=>showAssistantTaskChat(null))
it('does not guess a work from insertion order when an old agent link has several works',()=>{
 const first=task('first'),second=task('second')
 rememberAssistantTaskChat('ambiguous-owner',first);rememberAssistantTaskChat('ambiguous-owner',second)
 expect(readAssistantTaskChat('ambiguous-owner','reused-agent')).toBeNull()
 showAssistantTaskChat({ownerId:'ambiguous-owner',request:first,name:'Task'})
 expect(readAssistantTaskChat('ambiguous-owner','reused-agent')).toBe(first)
})
it('does not read an address saved without its work: a link opens the work it names, never an old window',()=>{
 const legacy={assistantId:'assistant',taskAgentId:'reused-agent',task:{deviceId:'old-device',sessionId:'old-session'},assistants:[]}
 localStorage.setItem('gugu:assistant-task-chats:v1:saved-owner',JSON.stringify([legacy,task('current')]))
 expect(readAssistantTaskChat('saved-owner','reused-agent')).toMatchObject({workId:'current',task:{sessionId:'session'}})
 expect(readAssistantTaskChat('other-owner','reused-agent')).toBeNull()
})
