import { afterAll, expect, it } from 'vitest'
import { i18n } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerMessagingCatalog'
import { encodeMessagingValue, resolveMessagingValue } from '../../../../apps/desktop/src/lib/localizedStoredValue'

const originalLanguage = i18n.language
afterAll(() => i18n.changeLanguage(originalLanguage))

it('reads stored group actions in the viewer’s language', async () => {
  await i18n.changeLanguage('en-US')
  expect(resolveMessagingValue('已加入群聊')).toBe('Joined the group chat')
  expect(resolveMessagingValue('已加入话题')).toBe('Joined the topic')
  expect(resolveMessagingValue('频道群主')).toBe('Channel owner')
  expect(resolveMessagingValue('迁移旧督导成员角色')).toBe('Migrated the previous supervisor role')
  expect(resolveMessagingValue(encodeMessagingValue('chatService.groupAction.joined'))).toBe('Joined the group chat')
  expect(resolveMessagingValue('其他动作')).toBe('其他动作')

  await i18n.changeLanguage('zh-CN')
  expect(resolveMessagingValue('已加入话题')).toBe('已加入话题')
})
