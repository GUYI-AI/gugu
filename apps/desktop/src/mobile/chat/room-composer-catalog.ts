import { registerLocaleNamespace } from '@/i18n/runtime'

registerLocaleNamespace('mobileRoomControls', {
  'zh-CN': { topics: '话题', loadingTopics: '正在读取话题', agents: '智能体', main: '群聊', noAgents: '群里还没有智能体', openSession: '进入任务对话', openProfile: '查看资料', loading: '正在读取智能体', failed: '暂时无法读取群里的智能体', retry: '重试' },
  'en-US': { topics: 'Topics', loadingTopics: 'Reading topics', agents: 'Agents', main: 'Group chat', noAgents: 'No Agents in this room', openSession: 'Open task conversation', openProfile: 'View profile', loading: 'Reading Agents', failed: 'Could not read this room’s Agents', retry: 'Retry' },
})
