import { i18n } from '@/i18n'

const MESSAGING_PREFIX = 'gugu:i18n:messaging:'

export function encodeMessagingValue(key: string): string {
  return `${MESSAGING_PREFIX}${key}`
}

export function resolveMessagingValue(value: string): string {
  switch (value) {
    // Group and topic membership RPCs also store these exact values as plain text.
    case '已加入群聊':
    case `${MESSAGING_PREFIX}chatService.groupAction.joined`:
      return i18n.t('chatService.groupAction.joined', { ns: 'messaging' })
    case '已加入话题':
      return i18n.t('chatService.groupAction.topicJoined', { ns: 'messaging' })
    case '频道群主':
      return i18n.t('chatService.groupAction.channelOwner', { ns: 'messaging' })
    case '迁移旧督导成员角色':
      return i18n.t('chatService.groupAction.supervisorRoleMigrated', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.groupAction.roleUpdated`:
      return i18n.t('chatService.groupAction.roleUpdated', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.scheduler.paused`:
      return i18n.t('chatService.scheduler.paused', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.scheduler.resumed`:
      return i18n.t('chatService.scheduler.resumed', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.taskAction.cancelled`:
      return i18n.t('chatService.taskAction.cancelled', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.taskAction.paused`:
      return i18n.t('chatService.taskAction.paused', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.taskAction.retried`:
      return i18n.t('chatService.taskAction.retried', { ns: 'messaging' })
    case `${MESSAGING_PREFIX}chatService.taskAction.transferred`:
      return i18n.t('chatService.taskAction.transferred', { ns: 'messaging' })
    default:
      return value
  }
}
