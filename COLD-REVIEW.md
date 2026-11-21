# PR #3283 冷读 review（只看代码）

对象：`pr3283` 对 `o/dev` 的 merge-base `412a07aac`。只读了代码，没看任何对照表、设计文档、PR 描述。
读法：产品 diff（去掉测试、json、md，共 593 个文件，约 4 万行 diff）分 5 块，每块全读；核心 `lib/replica.ts` 和跨块计数我自己做。
行号都是 PR head 的。路径省略前缀时：`S/` = `apps/desktop/src/`，`F/` = `apps/desktop/src/session/renderer/features/`。

## 先说结论

1. **净增被低估了，真实增长大约是账面的两倍。** 三个原因叠在一起：
   - 删掉的 472 行是死代码。`F/extensions/panel/app-featured.tsx`（232）和 `app-market-content.tsx`（240）在 base 上除了一条 `import type { AppMarketState }` 没有任何产品引用（已在仓库全量 grep 确认）。删它们是对的，但不该算进「读模型省下的行数」。扣掉后活代码净增约 **+1900**。
   - 行变长了。新增行平均 60.6 字符，删除行平均 54.0；超过 120 字符的行新增 1278 条、删除 701 条。按字符算是 +742k / −582k，净增 16 万字符，按 base 的行密度折合约 **+2950 行**（粗算，仅说明量级）。
   - 有些文件靠删注释把代码增长盖住了，见第 17 条。
2. **抽出来的公共件没人用，各处还在手写。** `ReadingSlot` 全 PR 只有 2 处使用，`writeOver` 3 处，`useReplicaPages` 3 处（都在 team 页）；而手写的 `state === 'unknown'` 有 153 处、`state === 'error'` 172 处、`x.state === 'value' ? x.value : null/undefined` 143 处。
3. **把不是「缓存读」的东西硬塞进 replica**，再加状态去补偿，是单点增长最大的来源（第 3 条）。
4. 下面 17 条加起来大约能省 **900–1000 行**（各条估算有少量重叠，没有编译验证）。把挤掉的行和删掉的契约注释还原，要加回 100–150 行。两者相抵，产品代码可以回到净增 +500 左右；再往下要动 `replica.ts` 本身的形状。

口径说明：我的过滤得到产品代码 +12212 / −10780 = **+1432**，和 owner 说的 +1247 口径略有不同（我把 `scripts/checks/*.mts` 也算进去了，它单独 +239）。

## 逐条（按能省的行数从多到少）

### 1. 给检查脚本看的标记注释，和每个调用点重抄一遍的说明 —— 约 110 行（挤行/注释类）
- `// @@@effect-flow(kind) - …` 新增 71 行、删除 20 行；`// @@@reading-default(…) - …` 新增 29 行。净增约 80 行，很多落在本 PR 没有别的改动的文件上，例如：
  - `S/components/chat/DocumentPreviewContent.tsx:136,182,246`、`chat/PdfPreview.tsx:42`、`session-watch/PhoneTaskBrowser.tsx:33,51`
  - `S/components/productTour/ProductTour.tsx`（4 处）、`ImagePreviewProvider.tsx:420`（单行 288 字符）
  - `F/extensions/extension-tab-pane.tsx:101`（该文件唯一改动）、`F/extensions/peek-folder-file.tsx:32,87`、`F/integrations/integrations-provider.tsx:82,103`
- `<RefreshFailed reading=…/>` 旁边那句「读过、再读失败……❌ 当成当前值画」在组件自己的注释里已经写过一次（`S/components/ui/RefreshFailed.tsx:5-10`），又在约 28 个调用点重抄，有的 2–3 行。例：`S/components/settings/AppsSection.tsx:67-69`、`settings/AssistantSection.tsx:57,121,152`、`markdown/LinkPill.tsx:68,143-144`、`S/mobile/assistant/usePhoneProfileData.ts:23,40`。
- `S/components/connections/connection-replicas.ts:49` 是 50–51 行注释的旧草稿，两份都留着。
- 怎么改：标记只留在真正难懂的 effect 上；如果是 `scripts/checks/effect-fetch-state.mts` 强制每个 effect 都要打标，该改的是检查脚本（用白名单文件而不是往产品代码里塞注释）。调用点的重抄全部删掉。

### 2. 薄包装和只用一次的 helper —— 约 100 行
- `F/sessions/create-session-modal/use-project-git-context.ts:1-15`：hook 现在只返回一个字段，一个调用方。内联，−13。
- `S/session/renderer/lib/stores/use-harness-model-credential.ts:24-35`：`credentialStatus` 一次性 8 行 switch。−8。
- `S/session/renderer/lib/providers/github-context-provider.tsx:15-19,73-83`：context 只剩一个无状态函数 `cancelGithubConnect`，改成普通 export。−8。
- `S/session/renderer/lib/stores/agents-answer.ts:1-6`：为一个布尔表达式开一个文件，一个调用方。−6。
- `S/session/renderer/lib/hooks/use-delay-boolean.ts:1-11`：一个调用方，文件名和导出名还对不上。−6（−11 如果 `gg-loading-line` 的 150ms 淡入已经够用）。
- `F/extensions/installed-extensions.ts:267-314`：同一份列表 5 个入口（`useInstalledApps` / `peekInstalledApps` / `fetchInstalledApps` / `peekInstalledAppsTracked` / `watchInstalled`），外加只有一个调用方的 `tellInstalled`。约 −10。
- `S/lib/myAssistant.ts:56-59` `refreshMyAssistant` = `myAssistant.refresh()`；`S/lib/assistantRulesState.ts:34-37`；`S/components/assistant/assistant-panel-replica.ts:33-35` `useAssistantPanel`；`assistant-panel-host.ts:70-73` `prefetchMyPanel`；`S/components/appSlot/marketOffers.ts:20-22`；`S/components/settings/phoneMarketPage.ts:38-40`；`F/sessions/diff-view/changes-panel/components/pr-entry/use-commit-files.ts:18-20`。都是 `useReplica(x, …)` 的一行转发。合计约 −20。
- `S/components/assistant/assistant-work-records.ts:51-58`：`watchLedger` / `watchWorks` 各带 4 个 lambda 转给 `watchWork`。−9。
- 把 reading 自带的 `retry` 再包一层闭包往下传：`F/sessions/diff-view/.../checks-list.tsx:133-136`、`image-diff-view.tsx:251`、`use-commits.ts:70-73`、`S/mobile/assistant/usePhoneToday.ts:23-26`、`PhoneMemory.tsx:53`、`F/assistant/assistant-ideas.tsx:36,44,98`、`F/automations/use-automations.ts:82,114-117`。约 −20。
- 其它：`F/settings/components/ExtensionsSettingsCard.tsx:120-125` `takenBack` = `byApp[id] ?? []`；`F/extensions/app-settings-page.tsx:113-118` 一次性组件；`F/global-search/use-global-search.ts:219-220,262-264` `answered()` 为不会出现的多元素情况写的；`S/components/appSlot/appsHere.ts:135` 无人引用的 re-export。约 −15。

### 3. 不是缓存读的东西硬做成 replica —— 约 100 行
- `S/components/chat/MessageFilePreview.tsx:66-67,90-136,196-256`：`previewShown` 是 `fresh: 0, keep: 0`（什么都不缓存），key 里塞一个 `attempt` 数字只为强制重读，还把函数 `file.source.read` 当参数传进去（代码自己的注释标着 ❌）。为此多了模块级进度 store、3 个组件状态和一个 5 分支表达式。base 是一个 effect 加一个 `read` 状态。文件 +59。改回一个 effect 管字节、进度、object URL 和租约，约 −45。
- `F/projects/components/main-panel/project-folders.ts:126-140,199-207,303-314`：`projectFolderLayout` 是一个 `read` 直接 `throw` 的 replica，实际只是一个 localStorage 槽；手写 FNV hash 做 key；再造 `workspaceId: 'pending:…'` 的假行混进真列表，然后 6 处过滤掉（`project-folders.ts:67,73`、`composer-folder-picker.tsx:55`、`project-folder-stage.tsx:262`、`project-run-machine.tsx:157`、`project-folder-card.tsx:292-296,467-474`）。改法：给 `projectFolders` 自己加 `persist`，或者返回 `pendingCount` 让卡片自己画骨架。约 −40。
- `S/components/assistant/AssistantCloseHost.tsx:43-61,171,178-198`：一次性弹窗读做成 `keep: 0` 的 replica，旧 effect 还因为唤醒步骤留着，多一个只当 key 用的 prop。约 −12。
- `S/components/session-watch/useSessionRestart.ts:14-23`：又一个 `fresh: 0` 的一次性检查。约 −5。

### 4. 三态分支到处手写，`ReadingSlot` 只用了 2 次 —— 约 90 行
- `S/components/ui/ReadingSlot.tsx` 自称「唯一画三态的地方」，全 PR 使用点只有 `settings/AssistantSection.tsx` 和 `F/settings/components/IntegrationDetailSidebar.tsx:98`。
- 手写的：`F/sessions/diff-view/changes-panel/components/pr-entry/commits-list.tsx:92-103,282-298`、`comments-list.tsx:102-112,123-125`、`pr-section.tsx:186-196`、`diff-view/main-panel/image-diff-view.tsx:169-178`、`F/projects/components/local-folder-project-modal.tsx:74-97`、`F/apps/apps-views.tsx:267-275`、`F/remote-hosts/workspace/remote-ports-tab-view.tsx:151-160`、`F/settings/components/GitHubAccountsSection.tsx:52-67`（和侧栏那处 `ReadingSlot` 是同一个 reading、同样的占位和文案）、`F/automations/components/AutomationRow.tsx:153-183,188-202`、`NextRunBanner.tsx:15-29`、`F/extensions/panel/app-manage-page.tsx:335-341,362-364`、`S/components/appSlot/OpenWithPick.tsx:19-37`（为画三态拆成两个组件）、`chat/ChatAppsPicker.tsx:73-99`、`chat/MessageMetaRow.tsx:95-96`、`assistant/AssistantServerSetup.tsx:124-128`。每处 4–6 行。
- 抄走样了：`AutomationRow.tsx:156,191` 传了 `error=` 但没传重试，这两处失败无法重试。
- 「失败 + 重试」有 4 个组件做同一件事：`S/components/ui/RefreshFailed.tsx`（67 处使用）、`S/session/renderer/lib/ui/read-failed-line.tsx`（本 PR 新增，32 处）、`remote-ports-tab-view.tsx:194-202` 本地又写了一个 `ReadFailed`（−9）、`S/features/team/TeamPrimitives.tsx:13-17` `TeamReadingState`。收成一个。

### 5. 分页、「保留上一份结果」、重试循环：replica 有，却各写各的 —— 约 70 行
- 保留上一 key 的结果，手搭 3 次：`F/command-palette/command-palette-modal.tsx:67-79`、`F/global-search/use-global-search.ts:140-165`（hook 体挪进 `useSearchView` 每次渲染调两遍）、`F/settings/components/ExtensionsSettingsCard.tsx:221-239`。base 是一个 `placeholderData: keepPreviousData` 选项。给 `useReplica` 加一个选项，约 −25。
- 分页：`F/sessions/diff-view/.../pr-entry/use-commits.ts:50-74` + `commits-list.tsx:66-72`（−20）；`S/components/legacy-dm-history/LegacyDmHistory.tsx:59-74,106-129` 同一块写两遍（−14）。`S/lib/replicaPages.ts` 已经提供 `first/pages/more/loadingMore/moreFailed`。
- 重试循环：`S/session/renderer/lib/hooks/useGithubAccounts.ts:12-13,21-31` 手写 `for (attempt…)` + `setTimeout`，而 `Definition.retry/retryDelay` 就在那（−7）；`S/components/preview/HtmlPreviewFrame.tsx:65-87` 把 base 的 `retry: 3` 展开成 20 行循环（−6）。

### 6. 定义里重复的选项 —— 约 70 行
- `fresh: 0` 是文档写明的默认值（`S/lib/replica.ts:65`），全 PR 写了 **23** 次。例：`S/features/team/replicas.ts:44,64,75,85,95,108`。−23。
- `networkMode: 'always'` 写了 **46** 次，其中 `S/session/renderer/lib/stores/agent-replicas.ts` 一个文件 9 次（`:31,40,48,72,85,99,118,128,139`）。「读的是某台机器而不是云」应该是定义上的一个属性或一个 `machineReplica()` 工厂。约 −30。
- `agent-replicas.ts:50-51,121-122,132-133` `retry: RETRIES, retryDelay: backoff` 三次；`:28-43` `agentsMetadata` 和 `managementAgents` 只差名字和 rpc 动词。
- `F/automations/automation-replicas.ts:40-102`：6 个模型每个都重复同样 4 个选项和一个「刷新自己」的 `watch`。−8。
- `S/lib/ownSettings.ts:19-37`：`ownSettings` 和 `chatOwnSettings` 是同一个定义写两遍，再加 `isChatScope` / `modelOf` 路由。−10。

### 7. 因为「读只认 key」长出来的闭包注册表，和三套「哪台机器」—— 约 65 行
- 渲染期往模块 Map 里登记闭包，好让 key-only 的 reader 找到：`F/integrations/CliInstallProgress.tsx:12-13,20-29,41`（`reportedFailures` 这个 Set 从不清）、`F/extensions/market-device-readings.ts:8-13`（整个文件为此存在）、`S/components/extensionBundle/packageReplicas.ts:23-28` `noteKeptCopy`、`S/mobile/market/phoneMarketTargets.ts:28-37`。数据本来可以直接当 replica 参数。约 −25。
- `S/components/extensionBundle/sharedPackages.ts:33-45` `sourceOfPackageKey`：先把 source 拼成字符串 key，再新写 12 行解析回来。把 source 对象直接当参数。−12。
- 手机端 3 个 setter 各带一句「phone App store is not loaded」：`F/extensions/installed-extensions.ts:66-73,355-362`、`market-replicas.ts:19-31`。合成一个注册对象，−12。
- `F/settings/app-settings-client.ts:42-48` `routeRemoteSettings` 和 `S/session/renderer/lib/ipc.ts:110-121` `routeMachine` 做同一件事（−8）。**顺带一个疑似 bug**：只有读走新路由（`:54`），写（`:134`）和重置（`use-app-settings-key.tsx:33`）还走 `rpcOn(host)`，手机上读写走的是两条管道。
- 「这台机器」三种写法并存：`null`（`agent-replicas.ts:22`）、字符串 `'local'`（`S/session/renderer/lib/machine-paths.ts:5-7`，还带一个转回 `null` 的函数）、host key `'local'`/`'remote:<id>'`。`F/library/library-host.ts:300-315` 在已有的 `machineHosts` 旁边又加了一套 `hostsByKey`。约 −12。

### 8. replica 缺一个「现在就重读」的操作，调用方各自拼 —— 约 55 行
- 「没人显示时 refresh 只是标脏，所以再 fetch/prefetch 一次」写了至少 9 处，每处都带一条解释同一个缺口的注释：`S/lib/cloudComputer.ts:181-183`、`projectRecovery.ts:32-34`、`sshLinkChannel.ts:51-54`、`billing/useSpendingPower.ts:130-134`、`replicaWrite.ts:22-24`、`S/components/assistant/assistant-panel-replica.ts:62`、`F/settings/app-settings-client.ts:159`、`F/extensions/register-extension-tabs.ts:45-46`、`F/extensions/installed-extensions.ts:281-286`（其中 284 行是死代码，282 行已经返回）、`ExtensionsSettingsCard.tsx:313-321`（9 行内联 `readNow`）。加一个方法，约 −25。
- 手写刷新扇出，而 `tags` / `refreshTag` 就是为此加的（`replica.ts:107` 写着「❌ a hand-written fan-out」）：
  - `agent-replicas.ts:145-158` `refreshAgentReadings` 手列 10 个模型，原因只是 machine 参数在 `harnessModelCatalog` / `harnessModelCredential` 里排在最后（`refresh(undefined, undefined, machine)`）。base 里有一段 20 行注释记录这种逐条列举漏过 4 次并写明不要回去，PR 删了注释又列回去了。−12。
  - 已装扩展相关 4 个模型在 `market-replicas.ts:258`、`NotificationSettingsCard.tsx:27`、`register-extension-tabs.ts:45-52`、`host-action-handlers.ts:432-434`、`market-detail-extension-devices.tsx:62-63`、`ExtensionsSettingsCard.tsx:322,604,751` 逐个刷新；`F/mcp/components/use-mcp-library.ts:119-124` 同样。−10。
- 「第一次订阅不算恢复」各自记标志位：`S/lib/myAssistant.ts:47-52`、`S/hooks/useStoredAgentTurnFailure.ts:78-86`。−8。

### 9. helper 已经有了却不用 —— 约 55 行
- `refreshFailure(reading)`（`replica.ts:45`）被原样重写约 25 处：`S/lib/cloudComputer.ts:115-119`、`hooks/useThisDeviceActions.ts:35`、`lib/connectionBridge.ts:67`、`components/settings/PasswordSection.tsx:117`、`settings/DevicesSection.tsx:222`、`F/integrations/integrations-provider.tsx:116`（本地 `errorOf`）、`F/global-search/use-global-search.ts:266-268`（又一个 `errorOf`）、`F/settings/subscriptions/SubscriptionConnections.tsx:134,135,570` 等。约 −15。
- `writeOver` 全 PR 只用 3 次；手写乐观写 + 回滚：`F/settings/app-settings-client.ts:138-154`（−12，「还没读到」的检查一次写操作跑两遍）、`S/components/assistant/useQuickChatState.ts:28-37`（base 是 4 行，−6）、`chat/AnnouncementDrawer.tsx:83-97`（−2）。
- `market-replicas.ts:182-185` 定义了 `unwrap`，同文件和邻近文件还有十几处把 `result.success` 检查展开写。−10。
- 绑定账号的写法两种并存：3 处用 `model.key(args)?.[1]` 去掏 key 的内部结构再 `useMemo`（`S/components/agentsettings/AgentTasksPane.tsx:60-63`、`settings/channels/WechatAppConnection.tsx:21-25`、`connections/OwnerConnectorMarketDetail.tsx:37-40`），其余地方在点击时直接 `model.at(...)`。−4。
- `replicaAccount()` 在 `replica.ts:733` 的注释是「Test seam」，实际被 10 处产品代码用来手写「await 之后账号变没变」（`ManagedVersionsRow.tsx:41-59` 一处就 4 次、`connectionBridge.ts:54,59`、`packageReplicas.ts:52`、`ownSettings.ts:41`、`phoneInstallation.ts:20`）。`at()` 就是干这个的。注释是错的，检查多数可删。约 −8。

### 10. 读函数里「catch 只为打日志再 throw」—— 约 55 行
- 约 20 处，每处还要自带一个 `rendererLogger(...)` 常量：`S/lib/assistantDm.ts:12-17`、`hooks/useThisDeviceActions.ts:17-22`、`hooks/useStoredAgentTurnFailure.ts:17-22`、`lib/sshMachineAddresses.ts:16-23`、`lib/cloudComputer.ts:53-55`、`lib/runtimeCapabilityPolicy.ts:16-21`、`components/assistant/AssistantCloseHost.tsx:55-60`、`assistant-work-records.ts:27-32`、`useAssistantWorkrooms.ts:26-29`、`session-watch/background-tasks.ts:58-63`、`chat/useConversationOptions.tsx:103`、`chat/useGroupChatSettings.ts:60`、`connections/connection-replicas.ts:39,154`、`hooks/useTopics.ts:79`、`S/session/renderer/lib/stores/agent-replicas.ts:101-110`、`F/sessions/task-dispatch-composer.tsx:33-36`、`F/extensions/market-replicas.ts:191-196`、`S/mobile/server-login/ServerLoginApproveSheet.tsx:27-34`。
- 怎么改：`replica.ts:127-132` `readFromKey` 是所有读必经的一个 catch，手上有模型名和 `replicaLog`。在那里记一次（+2 行），其余全删。

### 11. 只为测试留在产品里的代码 —— 约 55 行
- `S/features/team/replicas.ts:10-25`：`apis` Map + `keys` WeakMap + `teamApiKey` / `apiOf`，再把 `apiKey` 串进 6 个读的第一个参数和 7 个调用点。产品里 `TeamProvider` 只有 `App.tsx:189` 一处使用且不传 `api`；传 `api` 的全是 browser 测试（已全仓 grep）。直接用 `teamApi`，测试 mock 模块。−16。
- `S/lib/sshLinkChannel.ts:229-232` `subscribeSshLinkProblems`、`:391-395` `subscribeSshUpgrades`、`:202-205` `_setTunnelStateForTesting`：产品里零调用，只有两个单测在用，而且旁边已经有新的 `Readable`。−10。（`subscribeSshMachineIds` 是活的，`deviceRpc.ts:459` 在用，不算。）
- `S/mobile/ios-calendar/iosCalendarConnection.ts:4-13`：`setIOSCalendarClientForTesting` / `iosCalendarClient()`，注释自己写着 Test seam，24 行的文件里占 9 行。−9。
- `apps/desktop/electron/app-presence.ts:9-15,31`：`followAppPresence(deps)` 注入 `platform` / `on` / `getFocusedWindow` / `confirmMs`，唯一产品调用方在 `main.ts:2383-2388`，为此还要一个类型强转。−8。
- `F/extensions/register-extension-tabs.ts:28-41`：`stopFollowing` 重置模块状态并被返回，唯一调用方 `S/session/renderer/embedded.tsx:239` 不接返回值。−6。
- `S/lib/assistantPanelBodies.ts:28,75,71`：只实例化一次的工厂 + 无产品调用方的 `flush()`。−5。
- `F/extensions/market-replicas.ts:103-104`：懒加载的理由写的是「node tests render pages importing this module」。

### 12. select store 的重复形状 —— 约 50 行
- `S/components/session-watch/timeline-cache.ts:465-466,507-508,525-526`：三个同形状的 keyed store，各带 `initialX` / `updateX`；`:438-445` 为 Map 重写了一遍 `patch()`；`:484-494` 手工跟随 session，而 `createSelectStore(…, { scope: 'account' })` 的文档写着不要这样做。文件 +97，没有任何用户可见变化。−28。
- 同一个 setter 工厂写两遍：`session-watch/use-timeline-session.ts:378-391` 和 `useNativeSessionRecord.ts:24-32`。
- 「复制 Map、改一项、publish、notify」：`S/lib/sshLinkChannel.ts:218-227,347-355`，`lib/selectStore.ts:33-42` 的 `patch` 只支持 Record。−10。
- `publish(x); notify()` 成对手写 6 处，各藏在本地 `put` / `update` 后面：`S/components/WindowControls.tsx:57`、`extensionBundle/packageReplicas.ts:74-81`、`preview/file-place.ts:21-22`、`sessionpage/EmdashSessionFrame.tsx:233`、`S/mobile/share-intake/ShareIntakeHost.tsx:16`。给 store 加 `set(value)`。`WindowControls.tsx:40-70` 还为唯一的 `window.desktopWindow` 建了一个 WeakMap。−12。

### 13. 新读法旁边留着旧接口的适配层 —— 约 45 行
- `F/integrations/integrations-provider.tsx:103-119,264-276`：3 个 reading 拆成 9 个 context 字段，消费方再拼回三态（`assistant-home-integrations.tsx:124-131` 等）。直接把 Reading 放进 context，−10。
- 删掉的 `useChatChannels` hook 被原样敲进两个组件：`S/components/settings/channels/WechatAppConnection.tsx:19-33`、`connections/OwnerConnectorMarketDetail.tsx:33-44`。−10。
- `S/components/connections/connection-host.ts:58-66`：给旧的 `cache: { peek, save }` 接口现包一个适配对象，而这个接口唯一的实现已经是 replica；`:95-108` 用 12 行保证 `prefetch` 每账号只调一次，但 `prefetch` 对新鲜条目本来就是空操作。−8。
- `ExtensionsSettingsCard.tsx:172`：从 `installed.state` 派生一个 `'loading'|'error'|'ready'`，然后两套都在判；`:229-240` 把 replica 的值逐字段抄回旧形状。−9。
- `F/mcp/components/use-mcp-library.ts:87-118`：返回 reading 的同时再返回 5 个从它派生的标志。−5。
- `S/components/settings/CustomModelDialog.tsx:36-39`：把 Reading 转回 `{ data, error, refetch }`。−3。

### 14. `scripts/checks/effect-fetch-state.mts` —— 约 22 行（工具，不是运行时，但它 +239）
- 同一个遍历循环 5 份（`:104-113,409-418,421-430,472-480,524-534`），3 份是本 PR 加的；`ts.createSourceFile(...)` 写 4 次；主流程 `:537-563` 把刚扫过的文件再读一遍；`markerLines(path, text)` 的 `path` 没用到。

### 15. `lib/replica.ts` 自己（433 → 745 行）—— 约 20 行
- `:694-700` `readingOfState` 和 `:702-706` `readingOf` 是同一段逻辑两份。−4。
- 往 localStorage 写快照带同样的 try/catch 写了 3 处（`:395`、`:429-433`、`:484-488`）。−6。
- `:737-745` `useReplicaFetching` 把 `:530-531` 的 `argsMatch` 又内联写了一遍；`:609-612` `matches` 和 `:534-535` `matching` 是两种匹配写法。−3。
- 全 PR 只有 1 个调用方的 API：`refreshTagOn`（`:579-581`）、`onReturn`（`:149-151`）、`isShown`（`:657-660`）。`merge`、`refreshJoinsRead` 各 3 个使用点。−7。
- base 里多行的契约注释被压成一行（超过 140 字符的行 7 → 17），见第 17 条。

### 16. 其它小的重复 —— 约 40 行
- `x.state === 'value' ? x.value : null/undefined` 143 处；其中 `useAgents()` 的两行解包 13 处，base 是一行（`F/sessions/acp/acp-chat-panel.tsx:750,1746` 等）。加一个 `valueOf(reading)`，约 −15。
- host machine 前置三行重复 8 处，而 `S/session/renderer/lib/stores/use-agents.ts:9-12` 有个私有的 `useHostMachine` 正好是它。导出即可，−10。
- 「只在值变化时跑」用 ref 手写 5 次：`S/components/appSlot/GroupTabContent.tsx:163-166,220-223`、`assistant/useAssistantWorkrooms.ts:58-62`、`useAssistantDm.ts:23-27`、`appSlot/AppConversationSurfaceHost.tsx:62-65`。−8。
- 会员判断派生 3 次，注释逐字复制：`assistant/AssistantMoveGroup.tsx:44-46`、`AssistantOnboarding.tsx:109-111`、`AssistantShellHost.tsx:183`。−5。
- `S/components/assistant/assistant-panel-reads.ts:62-76` 自己写了一套 watch 引用计数，正是 PR 从 `chat/useChatPinSettings.ts` 删掉的那段，replica 的 `watch.group/start` 本来就有。（−14，已含在总数里。）

### 17. 挤行和删注释（修了会加行，约 +100 到 +150）
- 整体数字见开头：平均行长 54 → 60.6，超 120 字符的行 701 → 1278。
- base 多行、head 一行的例子：`S/store/devices.tsx:31`（9 行 import → 171 字符一行）、`S/lib/systemPermissions.ts:92`（5 行签名 → 168 字符）、`ExtensionsSettingsCard.tsx:231`（11 行对象 → 一行约 230 字符）、`S/mobile/phone-device/phoneInstallation.ts:16`（整个 `replica({...})` 定义一行）、`S/lib/assistantPanelBodies.ts:14`（203 字符的一行循环）、`replica.ts:1`（import）、`:190`、`:235`、`:666`（多语句一行）。
- 多条声明或语句挤一行：`S/components/chat/MessageFilePreview.tsx:201,224,273`、`S/layouts/MainLayout.tsx:336`、`S/features/team/replicas.ts:18`。
- 删注释盖住代码增长：
  - `installed-extensions-store.ts` → `installed-extensions.ts`：总行数 409 → 389，但代码行 256 → 315（+23%），注释 113 → 23。被删的是字段和方法的契约说明（`quit`、`origins`、`disclosure`、`forFiles`、更新计数的规则）。
  - `S/components/session-watch/use-timeline-session.ts`：账面 +33，实际代码 +58、注释 −28。
- 同时又在别处加了大量标记注释（第 1 条）。净效果是：有用的「为什么」变少，给脚本看的标签变多。

## 增长最不该有的文件

| 文件 | 净增 | 判断 |
|---|---|---|
| `S/lib/replica.ts` | +312 | 核心长了 72%，新增的 API 有几个只有 1–3 个使用点（第 15 条） |
| `scripts/checks/effect-fetch-state.mts` | +239 | 新的 lint 规则；它还是第 1 条那 80 行标记注释的来源 |
| `S/features/team/replicas.ts` | +110 | 行为不变，team 整体约 +90；主要是测试注入的注册表（第 11 条）和 6 个 `fresh: 0` |
| `S/components/session-watch/timeline-cache.ts` | +97 | 把原来的 `useState` 换成三个 store，无用户可见变化（第 12 条） |
| `F/sessions/stores/session-life-views.ts` | +89 | 是新行为，不是读模型改造；仍是 mobx store。`:127` 的 `listenOn` 用空 session id 订阅且不释放 |
| `S/components/chat/MessageFilePreview.tsx` | +59 | 第 3 条 |
| `F/global-search/use-global-search.ts` | +57 | 约 20 行是手搭的「保留上一份」（第 5 条） |
| `S/mobile/ios-calendar/*` | +41 | 行为相同（第 11 条 + 面板里每个状态都盖一个 `ownerId`） |

读模型确实起作用的地方（应该长这样）：`F/automations/use-automations.ts` −104、`ExtensionsSettingsCard.tsx` −88、`integrations-provider.tsx` −60、`S/hooks/useAgentFloodNotice.ts` −52、`S/lib/forwardedSource.ts` + `hooks/useForwardedSource.ts` −85、`use-session-schedules.ts` −51、`S/hooks/useAgentDisplayStatus.ts` −46。

## 顺带看到的风险（不是行数问题，都没有运行验证）

- `ExtensionsSettingsCard.tsx:1520,1524,1530` 用 `apps!` 渲染市场详情弹窗；唯一的提前返回（`:1124`）要求有远端 `notice`。本机清单读失败但货架读成功时，点开市场卡片可能直接抛错。
- 手机上设置的读和写走不同路由（第 7 条）。
- `AutomationRow.tsx:156,191` 的失败没有重试入口（第 4 条）。
- `S/lib/billing/useSpendingPower.ts:99-102` 没有「首次订阅」标志，第一个界面挂载时额度看起来会读两次。

## 可信度

- 每块都是全量读 diff 后对着 head 文件核过行号。我自己复核了：各 API 和选项的使用次数、`fresh: 0` 23 处、`networkMode: 'always'` 46 处、标记注释的增删数、行长统计、两个死文件、team / ssh / iOS 日历的测试专用结论（仓库全量 grep）。
- 一条分块结论被我推翻并去掉了：`fetchAgentHarnessModels` 不是死代码（`S/lib/assistantServerSetup.ts` 在用）。
- 没有复核的：各条的行数估算（都是读代码估的，没有实际改一遍）、「风险」一节。`agentModelReplicas.ts:10-13,52-61` 的 `catalogDetailed` 守卫看起来防的是不可能出现的状态（约 −14），把握中等，没有计入总数。
