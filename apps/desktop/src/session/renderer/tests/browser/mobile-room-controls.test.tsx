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

const locator=(unread:number,addressed:number)=>({stream_id:'s',stream_kind:'main' as const,thread_root_id:null,message_id:null,message_seq:null,unread_count:unread,addressed_count:addressed,cursor_seq:0,version:1,is_marked_unread:false})
const topics: TopicSummary[]=['设计讨论','一个用于检验窄屏与长名称的完整话题名称'].map((name,i)=>({chat_id:'topic-'+i,name,source_message_id:'anchor-'+i,creator_user_id:'owner',last_message_at:null,message_count:3,participant_count:2,is_participant:true}))
const member: MemberProfileCardModel={id:'peer-agent',displayName:'协作智能体',avatar:null,email:null,type:'agent',ownerUserId:'another-owner',role:'member',membership:'current',profileScope:'group',agentStatus:'offline'}
let harness: ReturnType<typeof createReactHarness> | null=null
let onPick=vi.fn(),onOpen=vi.fn(),retry=vi.fn()
let showTopicExternally: ((topic: TopicSummary | null) => void) | undefined
function Content({state='ready',selected=null}:{state?:'ready'|'loading'|'failed';selected?:TopicSummary|null}){
 const [handle]=useState(()=>Popover.createHandle<ActiveMemberProfile>())
 const [current,setCurrent]=useState(selected);showTopicExternally=setCurrent
 return <>
  <PhoneRoomComposerControls chatId="room" topics={state==='ready'?topics:[]} topicsReady={state==='ready'} current={current?{chatId:current.chat_id,name:current.name}:null} onPick={topic=>{onPick(topic);setCurrent(topic)}} members={state==='ready'?[member,{...member,id:'former-agent',membership:'former'},{...member,id:'human',type:'human'}]:[]}
   roster={{ready:state==='ready',failed:state==='failed',retry}} userId="owner" profileOpener={{handle}} onOpenAgent={onOpen} />
  <ChatComposer mobile editorOptions={{inputTestId:'room-editor'}} onSubmit={vi.fn()} />
  <MemberProfileRoot handle={handle}>{profile=><MemberProfilePopover profile={profile} onClose={()=>handle.close()} />}</MemberProfileRoot>
 </>
}
async function mount(theme:'light'|'dark'='dark',state:'ready'|'loading'|'failed'='ready',selected:TopicSummary|null=null,locale:'zh-CN'|'en-US'='zh-CN'){
 await page.viewport(360,780);document.documentElement.dataset.theme=theme;document.documentElement.setAttribute('data-phone-shell','');setLocalePreference(locale)
 harness=createReactHarness();Object.assign(harness.container.style,{position:'fixed',inset:'0',display:'flex',flexDirection:'column',justifyContent:'flex-end',padding:'8px'})
 await renderWithAppProviders(harness,<LocalizationProvider><SessionUiTheme theme={theme}><MessageProvider locale={locale} translate={translateSessionMessage}><Content state={state} selected={selected}/></MessageProvider></SessionUiTheme></LocalizationProvider>,{auth:{id:'owner'},chat:{chats:[chat({id:'room',kind:'group'}),chat({id:'topic-0',kind:'topic',unread_count:3,unread_locator:locator(3,1)}),chat({id:'topic-1',kind:'topic',unread_count:1,unread_locator:locator(1,0)})]},contacts:{contacts:[]}})
 await until('real composer',()=>!!harness?.container.querySelector('[contenteditable]'))
 return harness.container.querySelector<HTMLElement>('[contenteditable]')!
}
afterEach(()=>{harness?.cleanup();harness=null;document.documentElement.removeAttribute('data-phone-shell');onPick=vi.fn();onOpen=vi.fn();retry=vi.fn()})

it.each(['light','dark'] as const)('%s: topic and Agent sheets dismiss keyboard focus while preserving the editor and caret',async theme=>{
 const editor=await mount(theme);await page.getByTestId('room-editor').fill('正在输入中文')
 const text=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT).nextNode()!
 const selection=getSelection()!,range=document.createRange();range.setStart(text,2);range.collapse(true);selection.removeAllRanges();selection.addRange(range)
 const before={node:selection.anchorNode,offset:selection.anchorOffset,text:editor.textContent}
 const blur=vi.fn(),end=vi.fn();editor.addEventListener('blur',blur);editor.addEventListener('compositionend',end)
 editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'ni'}))
 await page.getByTestId('phone-room-topics').click();await page.getByRole('heading',{name:'话题 2',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click()
 await page.getByTestId('phone-room-agents').click();await page.getByRole('heading',{name:'智能体 1',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click()
 expect(harness!.container.querySelector('[contenteditable]')).toBe(editor);expect(document.activeElement).not.toBe(editor)
 expect(selection.anchorNode).toBe(before.node);expect(selection.anchorOffset).toBe(before.offset);expect(editor.textContent).toBe(before.text)
 expect(blur).toHaveBeenCalledTimes(1);expect(end).not.toHaveBeenCalled()
})

it('marks a topic that calls you in red and other unread with the grey dot, then dispatches the selected topic',async()=>{
 await mount();expect(document.querySelector('.gg-phone-composer-control-dot')?.getAttribute('data-tone')).toBe('call')
 await page.getByTestId('phone-room-topics').click()
 await expect.element(page.getByRole('radio',{name:'群聊',exact:true})).toBeVisible()
 const panel=document.querySelector<HTMLElement>('[data-testid="phone-room-controls-sheet"]')!
 const button=harness!.container.querySelector<HTMLButtonElement>('[data-testid="phone-room-topics"]')!
 await Promise.all(panel.getAnimations().map(animation=>animation.finished))
 expect(panel.getBoundingClientRect().width).toBe(320)
 expect(button.getBoundingClientRect().top-panel.getBoundingClientRect().bottom).toBeCloseTo(8)
 expect(panel.querySelector('.gg-phone-composer-sheet-handle')).toBeNull()
 const called=document.querySelector('[data-topic-id="topic-0"] .gg-chip')!,news=document.querySelector('[data-topic-id="topic-1"] .gg-chip')!
 expect([called.getAttribute('data-tone'),called.textContent]).toEqual(['danger','@1'])
 expect([news.getAttribute('data-shape'),news.getAttribute('aria-label')]).toEqual(['dot','有新消息，未提及你'])
 expect(document.querySelector('[data-testid="phone-room-main"] .gg-chip')).toBeNull()
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

it('keeps the short Topics trigger and does not toggle the current topic closed when selected again',async()=>{
 await mount('dark','ready',topics[0]);await expect.element(page.getByTestId('phone-room-topics')).toHaveTextContent('话题')
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
 await expect.element(page.getByRole('heading',{name:'智能体',exact:true})).toBeVisible()
 await expect.element(page.getByRole('status')).toHaveTextContent('正在读取智能体')
 expect(document.body.textContent).not.toContain('群里暂无智能体')
})


it('closes a retained room sheet when the host switches to another topic',async()=>{
 await mount();await page.getByTestId('phone-room-topics').click()
 await expect.element(page.getByRole('heading',{name:'话题 2',exact:true})).toBeVisible()
 showTopicExternally?.(topics[1]!)
 await until('external topic is active',()=>document.querySelector('[data-testid="phone-room-topics"]')?.getAttribute('data-active')==='true')
 await until('sheet closes',()=>document.querySelector('[data-testid="phone-room-controls-sheet"]')===null)
 await expect.element(page.getByTestId('phone-room-topics')).toHaveTextContent('话题')
 await page.getByTestId('phone-room-topics').click()
 expect(document.querySelector('[data-topic-id="topic-1"]')?.getAttribute('aria-checked')).toBe('true')
})

it.each([['zh-CN','话题','智能体'],['en-US','Topics','Agents']] as const)('%s: long topic names stay inside the menu and do not widen the trigger',async(locale,label,agents)=>{
 await mount('dark','ready',topics[1],locale)
 const trigger=harness!.container.querySelector<HTMLButtonElement>('[data-testid="phone-room-topics"]')!
 expect(trigger.textContent).toBe(label)
 expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
 expect(trigger.getAttribute('aria-expanded')).toBe('false')
 expect(trigger.querySelectorAll('svg')).toHaveLength(1)
 await expect.element(page.getByRole('button',{name:agents,exact:true})).toBeVisible()
 const box=trigger.getBoundingClientRect(),icon=trigger.querySelector('svg')!.getBoundingClientRect()
 await page.elementLocator(trigger).click({position:{x:icon.left+icon.width/2-box.left,y:icon.top+icon.height/2-box.top}})
 expect(trigger.getAttribute('aria-expanded')).toBe('true')
 const selected=document.querySelector<HTMLElement>('[data-topic-id="topic-1"]')!
 const name=selected.querySelector<HTMLElement>('.gg-phone-room-topic-name')!
 expect(name.textContent).toBe(topics[1]!.name)
 expect(getComputedStyle(name).whiteSpace).toBe('normal')
 expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth)
 expect(selected.getAttribute('aria-checked')).toBe('true')
 await page.elementLocator(selected).click()
 expect(onPick).not.toHaveBeenCalled()
 await until('current choice closes the menu',()=>document.querySelector('[data-testid="phone-room-controls-sheet"]')===null)
 await page.getByTestId('phone-room-topics').click()
 await page.getByRole('radio',{name:/设计讨论/}).click()
 expect(onPick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(topics[0]!))
 await until('chosen topic applied and menu closed',()=>document.querySelector('[data-testid="phone-room-controls-sheet"]')===null)
 await page.getByTestId('phone-room-topics').click()
 expect(document.querySelector('[data-topic-id="topic-0"]')?.getAttribute('aria-checked')).toBe('true')
 expect(document.querySelector('[data-topic-id="topic-1"]')?.getAttribute('aria-checked')).toBe('false')
})
