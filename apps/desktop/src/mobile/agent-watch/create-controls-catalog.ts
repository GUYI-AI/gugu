import { registerLocaleNamespace } from '@/i18n/runtime'

registerLocaleNamespace('mobileCreateControls', {
  'zh-CN': {
    modelDevice: '工作', project: '项目', folder: '文件夹', skills: '技能', skillsCount: '技能（{{count}}）',
    close: '关闭', back: '返回', device: '运行设备', agent: '智能体', model: '模型', effort: '推理强度', permission: '权限',
    searchSkills: '搜索技能', emptySkills: '没有可用的技能', noMatches: '没有匹配的技能', loadingSkills: '正在读取技能',
    failedSkills: '暂时无法读取这台设备的技能', retry: '重试',
    skillsHostUpdateRequired: '{{device}}上的咕咕版本暂不支持读取技能，请更新后重试',
    removeSkill: '移除技能 {{name}}', partialSkills: '部分技能未能读取',
    useSkills: '请使用以下技能：{{names}}。',
  },
  'en-US': {
    modelDevice: 'Work', project: 'Project', folder: 'Folder', skills: 'Skills', skillsCount: 'Skills ({{count}})',
    close: 'Close', back: 'Back', device: 'Run on', agent: 'Agent', model: 'Model', effort: 'Reasoning effort', permission: 'Permissions',
    searchSkills: 'Search skills', emptySkills: 'No skills available', noMatches: 'No matching skills', loadingSkills: 'Reading skills',
    failedSkills: 'Could not read skills from this device', retry: 'Retry',
    skillsHostUpdateRequired: 'Gugu on {{device}} does not support reading skills yet. Update it, then retry.',
    removeSkill: 'Remove skill {{name}}', partialSkills: 'Some skills could not be read',
    useSkills: 'Use the following skills: {{names}}.',
  },
})
