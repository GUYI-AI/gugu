/** Product configuration for the input composer menu bar (输入框菜单栏). */
export const PHONE_COMPOSER_MENU_BAR = {
  direct: [],
  attachmentOnly: ['attachments'],
  room: ['topics', 'agents'],
  agent: ['work', 'skills', 'agents'],
  roomAgent: ['work', 'skills', 'topics', 'agents'],
  create: ['work', 'project', 'skills'],
  projectTask: ['work', 'folder', 'skills'],
} as const

export type PhoneMenuSurface = keyof typeof PHONE_COMPOSER_MENU_BAR
export type PhoneMenuItem = (typeof PHONE_COMPOSER_MENU_BAR)[PhoneMenuSurface][number]

export function phoneMenuBar(surface: PhoneMenuSurface, available: Partial<Record<PhoneMenuItem, boolean>>) {
  return PHONE_COMPOSER_MENU_BAR[surface].filter(item => available[item] === true)
}
