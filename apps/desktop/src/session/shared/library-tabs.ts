/**
 * 资源库 = 给 agent 用的东西;咕咕这个 app 自己怎么表现归设置(owner 2026-09-15,#5688)。
 * 智能体、集成两页因此从设置搬到这里。App(原「扩展」)在这里待过一阵,10-01 起搬到最左栏自己的一格(apps 视图)。
 * MCP 那格 10-18 换了内容(owner 选的):原来只抄各家配置文件、不连 server;现在是咕咕自己管的列表(检测连接、
 * 新建任务时勾选),各家自己配的并排列出、只读。
 *
 * 「主题」11-07 加进来(owner 原话「除了 integrations 之外, 可以在资源库里加一个"主题"」):它管的是咕咕自己的外观,
 * 与上面「app 怎么表现归设置」那条相反,是 owner 这次点名放这里的;设置「通用」里留一行说当下用的哪族、点过来。
 * 它也是唯一**不分机器**的一格:主题只改这台电脑上的咕咕。
 *
 * 唯一的一份清单,类型从它推出来;LibraryMainPanel 以它为键配页面,少配一格就编译不过;App 的 `hostLinks` 也从它推出来。
 */
export const LIBRARY_TABS = ['prompts', 'agents', 'integrations', 'mcp', 'themes'] as const;

export type LibraryTab = (typeof LIBRARY_TABS)[number];
