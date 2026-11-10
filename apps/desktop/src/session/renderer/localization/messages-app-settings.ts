export const enUSAppSettingsMessages = {
  'appSettings.scopeFailed': 'Could not read or save which agents may use this App.',
  'appSettings.lastCallFailed': 'The last call failed.',
  'appSettings.overview': 'Overview',
  'appSettings.settings': 'Settings',
  'appSettings.save': 'Save',
  'appSettings.saved': 'Saved. New calls use these settings.',
  'appSettings.readFailed': 'Could not read this App.',
  'appSettings.saveFailed': 'Could not save these settings.',
} as const;

export const zhCNAppSettingsMessages: Record<keyof typeof enUSAppSettingsMessages, string> = {
  'appSettings.scopeFailed': '无法读取或保存 Agent 使用范围。',
  'appSettings.lastCallFailed': '上一次调用失败。',
  'appSettings.overview': '概览',
  'appSettings.settings': '设置',
  'appSettings.save': '保存',
  'appSettings.saved': '已保存，之后的调用使用新设置。',
  'appSettings.readFailed': '读不到这个 App。',
  'appSettings.saveFailed': '设置没能保存。',
};
