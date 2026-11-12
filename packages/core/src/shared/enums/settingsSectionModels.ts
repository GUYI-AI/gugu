export type ActiveSection =
  // The assistant's own pages (资料 = who it is and its state; connectors = the apps connected to it): not in Settings — they
  // live in its App, drawn over its panel (owner 11-06, 11-12「设置里面不应该有咕咕设置」). The keys stay for its own settings
  // page's inner sections and for old routes, which the shell sends to the App (`isAssistantSettingsSection`).
  | 'assistant'
  // Also the person's own connected apps on the phone: a plain row of Settings there (no 咕咕 heading), the phone having no
  // Library (a computer's home for them is the Library's 集成); never a Settings row on a computer.
  | 'connectors'
  | 'account'
  | 'general'
  | 'devices'
  // File storage and access is a primary destination beside Usage; existing deep links keep this key.
  | 'files'
  | 'model'
  | 'usage'
  // 用户自己在各家买的订阅(product spec):这台电脑上各家 Harness 的套餐与这一期还剩多少。
  | 'subscriptions'
  | 'about'
  | 'permissions'
  | 'passwords'
  // The phone's own App store (L9): the Apps installed on it from chats, to uninstall. The desktop manages its Apps on
  // the far-left rail's 「App」 page.
  | 'apps'
  // Legacy route only: the assistant's chat tools, part of its connected apps (in its App).
  | 'channels'
  // #7199 手机当设备:云端的个人助理能用这台手机做哪些事。只在手机壳上(桌面的「这台电脑能做的事」在「设备」里)。
  | 'phone'
  // Settings the session page holds (its own components draw them, product spec); only where a task host runs.
  | 'sessions'
  | 'interface'
  | 'resource-monitor'
  | 'browser'

/** The assistant's own pages (its 资料, its connected apps, its chat tools): a route to one opens its App, never Settings. */
export const isAssistantSettingsSection = (section: ActiveSection): section is 'assistant' | 'connectors' | 'channels' =>
  section === 'assistant' || section === 'connectors' || section === 'channels'

/** The sections the session page draws (its own components and settings store); shown only where a task host runs. */
export const SESSION_HOST_SETTINGS_SECTIONS: readonly ActiveSection[] = ['sessions', 'interface', 'browser', 'subscriptions', 'resource-monitor']

/** 设置左栏的分组(owner 10-16 全局设置重做):组名只在桌面左栏画小标题;手机「我的」同一份分组。 */
export type SettingsGroupId = 'account' | 'preferences' | 'work' | 'about'

/**
 * The one settings (product spec): sections in groups, a caption + divider between groups.
 * 账户 · 用量 · 文件存储 · 订阅 / 通用 · 界面 · 权限 · 模型 / 会话 · 仓库 · 浏览器 · 设备 · App / 关于.
 * Nothing of the assistant: it lives in its App (owner 11-12). 连接应用 under 通用 is the person's own, and only on the phone.
 * Which of them a host shows is SettingsPanel's filter (task host, system permissions, the phone's own Apps).
 * 桌面左栏与手机「我的」读的都是这一份,❌ 各写一个顺序。
 */
export const SETTINGS_GROUPS: readonly { readonly id: SettingsGroupId; readonly sections: readonly ActiveSection[] }[] = [
  // #986:用量合并积分与活跃统计;手机也能看,只是不上传本机数据。
  // File storage remains beside Usage; personal harness subscriptions stay in the same group.
  // 它读的是这台电脑上装着的 Harness,由会话页那一侧画 ⇒ 只在有会话页的地方出现。
  { id: 'account', sections: ['account', 'usage', 'files', 'subscriptions'] },
  // product spec:桌面与手机同一页;这台机器读不读得到真值由 SettingsPanel 那道过滤决定。
  // 连接应用:the person's own connected apps, a phone-only row (a computer has them in the Library's 集成).
  { id: 'preferences', sections: ['general', 'connectors', 'interface', 'permissions', 'passwords', 'model', 'resource-monitor'] },
  // agent 跑起来的那几样(会话的默认行为、仓库、浏览器)挨着「设备」。App 只在手机壳上:那里的 App 由
  // 这一页自己的 App 仓管(L9)。
  { id: 'work', sections: ['sessions', 'browser', 'devices', 'apps', 'phone'] },
  { id: 'about', sections: ['about'] },
]
export const SETTINGS_SECTION_GROUPS: readonly (readonly ActiveSection[])[] = SETTINGS_GROUPS.map((group) => group.sections)
// ❌ 别在这里加「机器与会话」:手机看管 agent 的入口只有底部「项目」tab(owner 2026-09-05),一张自带三层导航的
// 全屏页塞进设置详情,返回箭头要打两次架。

export const SETTINGS_SECTIONS: ActiveSection[] = SETTINGS_SECTION_GROUPS.flat()
