# #3283 读模型 PR-A：理论和代码对照

这张表回答一个问题：读模型理论里的每个概念，代码里是不是只在一个地方实现，有没有 hack。

- 理论：`evidence/pr2982-audit/contract.md`（概念 1–7，加上「回到 App 再读」）。
- 代码：PR head `4846f5fff`，已合入 dev `663d2a0d8`。
- 详细版（每一处的行号和搜索方法）：`evidence/pr2982-audit/theory/THEORY-MAP.md`。

## 结论

八个概念里有七个在代码里只有一处实现，都在 `lib/replica.ts`，各领域文件只写声明。剩下的是「三种状态画在一个地方」：14 处界面仍然手画，每处都有具体原因，列在第 2 节。另外有 3 处读法没有并进来，原因写在第 3 节。

## 1. 逐个概念对照

| # | 概念 | 理论要求的唯一位置 | 代码现状 | 结论 |
|---|---|---|---|---|
| 1 | 读数只有三种状态（未知 / 有值，可能附带上次刷新失败 / 失败） | `replica.ts` | `readingOf`。另有 7 处在拼接或改写读数（例如把两个读数合成一个），都不是第二套状态机 | 一处 |
| 1b | 每个读数自带重试 | `replica.ts` `retryOf(reading)` | 29 处调用它。第一轮只查了两个组件，结论写的是「0 处手写重试」，这是错的；扩大检查规则后找出 30 处手写重试，已全部改用读数自带的重试（第 4 节） | 一处 |
| 2 | 按标签整组刷新 | `refreshTag` | 原来手写的 5 个整组刷新函数已删掉。保留 `refreshAgentReadings`：它刷新的 10 个模型里，机器参数位置各不相同，还要在安装进行时保留安装状态，属于领域策略，不是单纯批量刷新 | 一处 |
| 3 | 有界面在看时才开推送订阅，按引用计数 | `watch` + `hold` | 29 个模型声明了 `watch`。`session-life-views` 自己维护计数，原因见第 3 节 | 本 PR 的读路径里只有一处 |
| 4 | 读不能盖掉更新的写 | `replica.ts` 的 write-over-read 规则 | 原来云电脑自带的 `issued/applied` 计数已删除。`useGroupChatSettings` 自己的写计数是 dev 的代码，按约定留给后续 PR | 一处 |
| 5 | 账号切换的判断 | `onAccountChange` | store 用 `createSelectStore(…, { scope: 'account' })`。另外几处 `subscribeAccount` 只在窗口之间传递账号，不做账号判断 | 一处 |
| 6 | 三种状态画在同一个组件 | `ReadingSlot` / `RefreshFailed reading=` | `RefreshFailed reading=` 49 处，`ReadingSlot` 2 处，`ReadFailedLine` 17 处，`SettingValue` 11 行设置。另有 14 处手画（第 2 节） | 不是一处，例外见第 2 节 |
| 7 | 不要薄包装 | 调用方直接用 `useReplica` | 纯转发的包装从 9 个减到 4 个。剩下的 4 个：一个做了数据转换，3 个被 50 多个测试按名字 mock。另有 19 个 `use*` hook 各自带条件（什么时候读、读哪台机器），属于领域逻辑 | 剩 4 个，原因已说明 |
| — | 回到 App 时重读 | `lib/foregroundReturn.ts` | 各界面自己挂的 `focus` / `visibilitychange` 监听已全部删除 | 一处 |

## 2. 仍然手画三种状态的 14 处，以及原因

| 原因 | 位置 |
|---|---|
| 整行本身是按钮，里面再放重试按钮就成了按钮套按钮 | AutomationRow（4 处） |
| 在下拉选项列表里，放重试按钮等于往列表里塞一个可交互元素 | SessionSettingsRows:113、TerminalSettingsCard:259 |
| 「失败」本身就是答案（例如市场连不上、云端不可用） | AppsSection:90、AssistantMoveGroup:126 |
| 页面上已有自己的「刷新」按钮，再加一个重试会改变界面 | AssistantServerSetup:124/138 |
| 只是行内的一句说明，同一组的底部已经通过 `reading=` 报了失败 | ComputerHomeSettings:29、app-manage-page:338 |
| 每行一条备注，或回退到别的文字 | AddGroupMembers:72、PhoneProjectContacts:100、SessionSettingsRows:68 |
| 跟空成员状态合在一起，而且是冻结文件 | ContactsPanel:813 |
| 父组件已经拿到值才会挂载，占位分支永远不会画出来 | app-settings-page:59/61 |
| 数据是快照，不是读数 | SidebarUsage:119 |

另外有 20 处用 `RefreshFailed error=`，是多个读数一起失败或写失败的情况，理论里 `error=` 本来就是给这种情况用的。

## 3. 代码里有、理论里没写的东西

| 东西 | 行数 | 替代了什么 |
|---|---|---|
| `useReplicaPages`（分页读） | 36 | dev 团队版用 `useInfiniteQuery` 和自己的 QueryClient 读 4 个分页列表，现在都走 replica |
| `writeOver`（乐观写 + 回滚） | 30 | 原来 3 处各写一遍的乐观写 |
| `mobxReadable` + `useMobxReading` | 20 | 让 3 处 MobX 派生数据也通过统一的订阅路径读取，本身不读数据 |
| `session-life-views` 保留 MobX | — | ACP 聊天 store 有 18 个 reaction 在读它。要改成 replica，得新做一个 replica→MobX 桥，或者重写 ACP store，这属于 ACP store 的迁移，不在本 PR 范围 |

## 4. 第二轮检查发现并修掉的问题（owner 11-20 07:37 提出「实现要跟理论一致，不要 hack」之后）

- 手写重试：检查规则原来只看两个组件，所以漏了 30 处。现在规则改成：凡是只调用 `model.refresh(args)` 的事件处理函数都会报错。30 处已全部改用 `retryOf(reading)`；`SettingValue` 改为用读数自带的重试，删掉 `onReadAgain` 参数。
- 删除：`use-version-history.ts`、两个把读数转成 `Loadable` 的适配器，以及没人调用的 `CloudComputerLoadError`。
- `ChatAreaPanel.tsx`（冻结文件）：本 PR 曾把 7 行 import 挤到一行，以压低行数。已恢复成每行一个 import。
- 这一轮合计：产品代码 −31 行，测试 +5 行。

## 5. 收口和行数（11-21，对比 dev 7db4b05f6）

目标改成「每类数据只有一条读路径」，行数只作参考。逐类表格见 `ROUND3-REPORT.md` 和 `tools/paths-1..4.md`。

| 领域 | 数据种类 | dev 读路径 | 现在 | 仍有 2 条以上 |
|---|---|---|---|---|
| App / 市场 | 25 | 45 | 25 | 0 |
| agent、连接、团队、自动化 | 39 | 52 | 43 | 4 |
| 助理面板、云电脑、设备、手机、设置 | 43 | 100 | 74 | 12 |
| 会话、聊天、git、搜索、文件 | 26 | 34 | 25 | 1 |
| 合计 | 133 | 231 | 167 | 17 |

还剩多条路径的 17 类，每类的原因写在 ROUND3-REPORT.md 里。主要是三类：
- 市场设备选择器靠按种类的闭包从 replica 派生读数；
- 「写之后才开始的读」需要 replica 增加一个新操作；
- MobX store（项目、会话列表）还各留一份副本。

机制上新增的能力：`reread`、`readOnce`、`useEntry`、`keepPrevious`、`valueOf`、失败只记一次日志、store 的 `set` 和 Map `patch`、ReadingSlot 接受元素。豁免从产品代码里的标记注释，改成规则旁边的一份清单。

行数：产品代码 +11348 −11126，净增 **+222**；测试净增 +7249。按审查口径剔除两个死文件（472 行），净增 **+694**。新增的行仍然比删掉的长，平均 62.1 字符，dev 是 53.5。按字符折算成 dev 的行长，净增约 +2175 行；重开时约是 +2962 行。

## 6. 这次合入 dev 663d2a0d8（11-20）

dev 在这期间新增的读取，同样改成走 replica：

- 失效本地项目（#3158）：dev 用 react-query 读，外加自己挂了一个窗口 `focus` 监听。现在改成一个 replica，回到 App 时重读，跟其它模型一样。
- 聊天的「应用」选择器（#3330）和侧栏 App 列表：改为读已安装应用的 replica。
- 其余冲突按 dev 的行为合并：任务页「+」菜单不再列 App；订阅连接的登录和原生连接规则；没有 agent 的聊天不读失败记录。
