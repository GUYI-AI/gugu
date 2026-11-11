// The first-run introduction's words about the assistant (#1931 F1: moved out of the desktop's `main` and `assistant`
// catalogs unchanged). The host draws the page around them.
import type { AssistantIntroCopy } from '../assistantRulesFormat'

export const ASSISTANT_INTRO: Readonly<Record<string, Readonly<AssistantIntroCopy>>> = Object.freeze({
  'en-US': Object.freeze({
    title: 'Meet Gugu',
    summary: 'Gugu is your personal assistant for plans and everyday tasks.',
    desktopBody: 'Your personal assistant for plans and everyday tasks. At the top of the left rail.',
    phoneBody: 'Your personal assistant for plans and everyday tasks. Find Gugu at the top of Messages.',
  }),
  'zh-CN': Object.freeze({
    title: '认识咕咕',
    summary: '咕咕是你的个人助理，帮你记安排、办事情。',
    desktopBody: '你的个人助理，帮你记安排、办事情。在左栏最上面。',
    phoneBody: '你的个人助理，帮你记安排、办事情。打开「消息」，第一行就是咕咕。',
  }),
})
