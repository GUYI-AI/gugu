import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { Popover } from '@/components/ui/Popover'
import { MemberProfileRoot, MemberProfilePopover } from '@/components/MemberProfilePopover'
import type { ActiveMemberProfile } from '@/components/memberProfileModels'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import { PhoneRoomComposerControls } from '@/mobile/chat/PhoneRoomComposerControls'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { chat, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

const topics: TopicSummary[]=['设计讨论','一个用于检验窄屏与长名称的完整话题名称'].map((name,i)=>({chat_id:'topic-'+i,name,source_message_id:'anchor-'+i,creator_user_id:'owner',last_message_at:null,message_count:3,participant_count:2,is_participant:true}))
const member: MemberProfileCardModel={id:'peer-agent',displayName:'协作智能体',avatar:null,email:null,type:'agent',ownerUserId:'another-owner',role:'member',membership:'current',profileScope:'group',agentStatus:'offline'}
let harness: ReturnType<typeof createReactHarness> | null=null
let onPick=vi.fn(),onOpen=vi.fn(),retry=vi.fn()
let showTopicExternally: ((topic: TopicSummary | null) => void) | undefined
function Content({state='ready',selected=null}:{state?:'ready'|'loading'|'failed';selected?:TopicSummary|null}){
 const [handle]=useState(()=>Popover.createHandle<ActiveMemberProfile>())
 const [current,setCurrent]=useState(selected);showTopicExternally=setCurrent
 return <>
  <PhoneRoomComposerControls chatId="room" topics={topics} current={current?{chatId:current.chat_id,name:current.name}:null} onPick={onPick} members={state==='ready'?[member]:[]}
   roster={{ready:state==='ready',failed:state==='failed',retry}} userId="owner" profileOpener={{handle,openedFrom:'main'}} onOpenAgent={onOpen} />
  <ChatComposer mobile editorOptions={{inputTestId:'room-editor'}} onSubmit={vi.fn()} />
  <MemberProfileRoot handle={handle}>{profile=><MemberProfilePopover profile={profile} onClose={()=>handle.close()} />}</MemberProfileRoot>
 </>
}
async function mount(theme:'light'|'dark'='dark',state:'ready'|'loading'|'failed'='ready',selected:TopicSummary|null=null){
 await page.viewport(360,780);document.documentElement.dataset.theme=theme;document.documentElement.setAttribute('data-phone-shell','');setLocalePreference('zh-CN')
 harness=createReactHarness();Object.assign(harness.container.style,{position:'fixed',inset:'0',display:'flex',flexDirection:'column',justifyContent:'flex-end',padding:'8px'})
 await renderWithAppProviders(harness,<LocalizationProvider><SessionUiTheme theme={theme}><MessageProvider locale="zh-CN" translate={translateSessionMessage}><Content state={state} selected={selected}/></MessageProvider></SessionUiTheme></LocalizationProvider>,{auth:{id:'owner'},chat:{chats:[chat({id:'room',kind:'group'}),chat({id:'topic-0',kind:'topic',unread_count:3}),chat({id:'topic-1',kind:'topic',unread_count:1})]},contacts:{contacts:[]}})
 await until('real composer',()=>!!harness?.container.querySelector('[contenteditable]'))
 return harness.container.querySelector<HTMLElement>('[contenteditable]')!
}
afterEach(()=>{harness?.cleanup();harness=null;document.documentElement.removeAttribute('data-phone-shell');onPick=vi.fn();onOpen=vi.fn();retry=vi.fn()})

it.each(['light','dark'] as const)('%s: topic and Agent sheets preserve the composing editor and caret',async theme=>{
 const editor=await mount(theme);await page.getByTestId('room-editor').fill('正在输入中文')
 const text=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT).nextNode()!
 const selection=getSelection()!,range=document.createRange();range.setStart(text,2);range.collapse(true);selection.removeAllRanges();selection.addRange(range)
 const before={node:selection.anchorNode,offset:selection.anchorOffset,text:editor.textContent}
 const blur=vi.fn(),end=vi.fn();editor.addEventListener('blur',blur);editor.addEventListener('compositionend',end)
 editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'ni'}))
 await page.getByTestId('phone-room-topics').click();await page.getByRole('heading',{name:'话题',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click()
 await page.getByTestId('phone-room-agents').click();await page.getByRole('heading',{name:'智能体',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click()
 expect(harness!.container.querySelector('[contenteditable]')).toBe(editor);expect(document.activeElement).toBe(editor)
 expect(selection.anchorNode).toBe(before.node);expect(selection.anchorOffset).toBe(before.offset);expect(editor.textContent).toBe(before.text)
 expect(blur).not.toHaveBeenCalled();expect(end).not.toHaveBeenCalled()
})

it('lists the main room and every topic with real unread values and dispatches the selected topic',async()=>{
 await mount();await page.getByTestId('phone-room-topics').click()
 await expect.element(page.getByRole('radio',{name:'群聊',exact:true})).toBeVisible()
 await expect.element(page.getByLabelText('3 条未读',{exact:true})).toBeVisible()
 await expect.element(page.getByLabelText('1 条未读',{exact:true})).toBeVisible()
 await page.getByRole('radio',{name:/设计讨论/}).click()
 expect(onPick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(topics[0]!));await until('sheet closes',()=>document.querySelector('[data-testid="phone-room-controls-sheet"]')===null)
})

it('opens the existing profile card for another person’s Agent without entering a DM',async()=>{
 await mount();await page.getByTestId('phone-room-agents').click()
 await expect.element(page.getByTestId('phone-room-agent')).toHaveTextContent('协作智能体')
 await page.getByTestId('phone-room-agent').click()
 await until('existing profile card',()=>!!document.querySelector('[data-profile-member-id="peer-agent"]'))
 expect(onOpen).not.toHaveBeenCalled()
})

it('shows the current topic name and does not toggle it closed when selected again',async()=>{
 await mount('dark','ready',topics[0]);await expect.element(page.getByTestId('phone-room-topics')).toHaveTextContent('设计讨论')
 await page.getByTestId('phone-room-topics').click();await page.getByRole('radio',{name:/设计讨论/}).click()
 expect(onPick).not.toHaveBeenCalled();await until('sheet closes',()=>document.querySelector('[data-testid="phone-room-controls-sheet"]')===null)
 await page.getByTestId('phone-room-topics').click();await page.getByRole('radio',{name:'群聊',exact:true}).click()
 expect(onPick).toHaveBeenCalledExactlyOnceWith(null)
})

it('keeps a narrow sheet in the viewport and exposes a real failed read with Retry',async()=>{
 await mount('light','failed');await page.viewport(320,640);await page.getByTestId('phone-room-agents').click()
 await expect.element(page.getByRole('alert')).toHaveTextContent('暂时无法读取群里的智能体')
 await page.getByRole('button',{name:'重试',exact:true}).click();expect(retry).toHaveBeenCalledOnce()
 const panel=document.querySelector<HTMLElement>('[data-testid="phone-room-controls-sheet"]')!
 await Promise.all(panel.getAnimations().map(a=>a.finished));const box=panel.getBoundingClientRect()
 expect(box.left).toBeGreaterThanOrEqual(12);expect(box.right).toBeLessThanOrEqual(308);expect(box.bottom).toBeLessThanOrEqual(640)
 expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320)
})

it('does not present an unread roster as an empty group',async()=>{
 await mount('dark','loading');await page.getByTestId('phone-room-agents').click()
 await expect.element(page.getByRole('status')).toHaveTextContent('正在读取智能体')
 expect(document.body.textContent).not.toContain('群里还没有智能体')
})


it('closes a retained room sheet when the host switches to another topic',async()=>{
 await mount();await page.getByTestId('phone-room-topics').click()
 await expect.element(page.getByRole('heading',{name:'话题',exact:true})).toBeVisible()
 showTopicExternally?.(topics[1]!)
 await until('external topic name',()=>document.querySelector('[data-testid="phone-room-topics"]')?.textContent?.includes(topics[1]!.name)===true)
 await until('sheet closes',()=>document.querySelector('[data-testid="phone-room-controls-sheet"]')===null)
})

it.each(['light','dark'] as const)('%s: the room sheet covers the editor at every opening frame',async theme=>{
 await mount(theme)
 const samples: { opacity: string; alpha: number; coversEditor: boolean }[]=[]
 const observer=new MutationObserver(()=>{
  const popup=document.querySelector<HTMLElement>('[data-testid="phone-room-controls-sheet"]')
  if(!popup)return
  observer.disconnect()
  function sample(){
   if(!popup!.isConnected||samples.length>=12)return
   const style=getComputedStyle(popup!),rect=popup!.getBoundingClientRect()
   const editor=harness!.container.querySelector<HTMLElement>('[contenteditable]')!,input=editor.getBoundingClientRect()
   const top=Math.max(rect.top,input.top),bottom=Math.min(rect.bottom,input.bottom),left=Math.max(rect.left,input.left),right=Math.min(rect.right,input.right)
   const covered=bottom>top&&right>left&&popup!.contains(document.elementFromPoint((left+right)/2,(top+bottom)/2))
   const canvas=document.createElement('canvas'),context=canvas.getContext('2d')!;canvas.width=canvas.height=1;context.fillStyle=style.backgroundColor;context.fillRect(0,0,1,1)
   samples.push({opacity:style.opacity,alpha:context.getImageData(0,0,1,1).data[3]!,coversEditor:covered})
   requestAnimationFrame(sample)
  }
  sample()
 })
 observer.observe(document.body,{childList:true,subtree:true})
 await page.getByTestId('phone-room-topics').click()
 await until('the sheet has painted its first three frames',()=>samples.length>=3)
 observer.disconnect()
 expect(samples.every(frame=>frame.opacity==='1')).toBe(true)
 expect(samples.every(frame=>frame.alpha===255)).toBe(true)
 expect(samples.every(frame=>frame.coversEditor)).toBe(true)
})
