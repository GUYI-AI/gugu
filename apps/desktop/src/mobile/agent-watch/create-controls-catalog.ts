import { registerLocaleNamespace } from '@/i18n/runtime'

registerLocaleNamespace('mobileCreateControls', {
  'zh-CN': {
    modelDevice: '工作', project: '项目', folder: '文件夹', skills: '技能', skillsCount: '技能（{{count}}）',
    close: '关闭', back: '返回', device: '运行设备', agent: '智能体', model: '模型', effort: '思考强度', permission: '权限',
    switchingFast: '切换中…',
    searchSkills: '搜索技能', emptySkills: '没有可用的技能', noMatches: '没有匹配的技能', loadingSkills: '正在读取技能',
    searchModels: '搜索模型', clearModelSearch: '清空模型搜索', noMatchingModels: '没有匹配的模型',
    failedSkills: '暂时无法读取这台设备的技能', retry: '重试',
    skillsHostUpdateRequired: '{{device}}上的咕咕版本暂不支持读取技能，请更新后重试',
    skillsHostMethodUnavailable: '{{device}}未提供技能读取接口，请检查那台设备的咕咕版本后重试',
    removeSkill: '移除技能 {{name}}', partialSkills: '部分技能未能读取',
    useSkills: '请使用以下技能：{{names}}。',
  },
  'en-US': {
    modelDevice: 'Work', project: 'Project', folder: 'Folder', skills: 'Skills', skillsCount: 'Skills ({{count}})',
    close: 'Close', back: 'Back', device: 'Run on', agent: 'Agent', model: 'Model', effort: 'Reasoning effort', permission: 'Permissions',
    switchingFast: 'Switching…',
    searchSkills: 'Search skills', emptySkills: 'No skills available', noMatches: 'No matching skills', loadingSkills: 'Reading skills',
    searchModels: 'Search models', clearModelSearch: 'Clear model search', noMatchingModels: 'No matching models',
    failedSkills: 'Could not read skills from this device', retry: 'Retry',
    skillsHostUpdateRequired: 'Gugu on {{device}} does not support reading skills yet. Update it, then retry.',
    skillsHostMethodUnavailable: '{{device}} did not provide the skill-reading method. Check Gugu on that device, then retry.',
    removeSkill: 'Remove skill {{name}}', partialSkills: 'Some skills could not be read',
    useSkills: 'Use the following skills: {{names}}.',
  },
})
