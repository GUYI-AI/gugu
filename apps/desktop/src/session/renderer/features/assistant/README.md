# 「助理」(#7199)

个人助理(人级别的 agent,不住项目区)。**桌面上它的页就是装好的受信助理 App `gugu-assistant`**(API 41 的 App 页 + 旁边那条会话):
最左栏顶格、通知、链接、任务卡、快速聊天的「打开」都经同一个决定 `decideAssistantEntry`(`lib/assistantEntry.ts`)——
App 可用 → 它的页(没有助理时是 App 自己的开通页);App 不可用(还在装 / 被关掉)→ 和它的私聊当普通聊天开,没有助理就去设置「咕咕」开通。内置的会话页视图 `assistant` 已删。
产品预期见 product spec。这个目录剩下的是壳仍在画的(设置页、开通流程、设备页、语音笔记录音与转写、给 App 的宿主接口要读的数据)和手机仍共用的几块。

**设置不在 App 里**(owner 10-16「只有一个设置,咕咕的设置是全局设置里的一组;齿轮直接开到那一组,❌ 再有第二个设置页」):
齿轮 = `UI_EVENTS.openSettings {section:'assistant'}`;「资料」页的「连接应用」「聊天工具」行同样直接打开全局设置的 `connectors` / `channels`。
那一组住在 `components/settings/AssistantSection.tsx`(资料:名字、形象与性格、状态、快速聊天、关闭、会议提醒)与 `ConnectorsSection.tsx`(连接应用:云端 / 本机 / 其他设备);
云端那一段由会话页画(`assistant-connectors-settings.tsx`,资源库「集成」的同一份数据),经 `SessionSettingsContent` 渲染进设置弹窗。
设备页(`devices`)是「咕咕能操作哪些」的视图,点进去的详情与全局设置「设备」同一个组件。

样子全在 `assistant-today.css`(`.ta-*`,亮暗两套 token)。

**视觉 token(玻璃 + 字阶,别逐页自己写)**:变量挂在 `.ta-app, .ta-dialog, .ta-phone, [data-ta-menu]` 上。
玻璃 = `background: var(--ta-glass)` + `backdrop-filter: blur(var(--ta-glass-blur))` + `box-shadow: var(--ta-glass-fx)`(白描边 + 顶沿高光);
**尺寸一律取咕咕自己的读数**(2026-10-16 owner):`--ta-fs-page` = `--font-title` 15/22 600(手机 20/28)、`--ta-fs-section` = `--font-caption` 11/16 600、`--ta-fs-row` = `--font-body` 13/20 500(手机 `--font-title` 15/22)、`--ta-fs-sub` / `-note` / `-btn` = `--font-body`(配 `--ta-lh-*`);圆角 `--ta-radius-card` / `-panel` = `--radius-xl` 12、`--ta-radius-control` = `--radius-control` 8、`--ta-radius-thread` = 16(输入条),capsule 只给头像 / 开关 / 发送钮 / 分段标签;高度 `--ta-h-control` 28(手机 44)、`--ta-h-circle` 32、`--ta-h-top` 52;内边距 `--ta-pad-card` 16、`--ta-pad-row-y/x` 12/16。
壳画进来的设置原语(`gg-settings-*`)在 `.ta-skin` 里读同一组;设置弹窗的行标题 / 说明就是 `--font-body`(13/20),与助理 App 读同一对 token。
portal 到 body 的菜单加 `data-ta-menu=""` 即得玻璃。

**颜色(owner 10-16:配色不要太跳)**:底色是咕咕自己的中性底 —— `--ta-app-bg = var(--page)`、`--ta-panel-bg = var(--bg)` + 顶上一抹 `--ta-tint-wash`,❌ 大块彩色渐变;质感靠玻璃,不靠颜色。
整页唯一的颜色 = 助理主题色 `--ta-tint`(色相 `--ta-tint-h`,默认跟咕咕 `--tint`;明度 / 彩度按亮暗在 token 里定),派生 `--ta-tint-wash`(面板顶一抹)、`--ta-tint-soft`(选中态底)、`--ta-tint-ink`(选中态字)。
新用户引导里选了小鸟颜色 → 在 `.ta-app` / `.ta-phone` **根上 inline 覆盖 `--ta-tint-h`**(一个数,0–360)。页里 ❌ 自己写十六进制色;状态语义色(健康 `--ta-health-*`、成功 / 失败)除外。
派生量(`--ta-tint*`)是在声明它的那个元素上算好再往下继承的 —— 子元素上改 `--ta-tint-h` 不会重算;要在子树里换色(引导页实时预览),在那个子树根上加 `data-ta-scope`(变量整组在它身上重新声明,色相读它自己的 inline 值)。

## 壳那棵树里的东西

会话页与咕咕壳是同一个 document 里两个 React 根,壳的 context(通讯录、设备、聊天、登录态)到不了这里。所以:

- 壳 → 这里:`lib/assistantShellBridge.ts` 发布云电脑状态、个人助理是谁(`assistantState` 分清在读 / 没有 / 读不到)、主人叫什么、和它那条私聊(`chatId`,`useAssistantDm`);这里用 `useAssistantShell()` 读。
- 这里 → 壳:`<ShellSlot name="…" />` 留格子,`components/assistant/AssistantShellHost.tsx` 把壳的组件 portal 进来(`devices` → `AssistantDevicesPage`)。格子外层加 `.ta-skin`。(云电脑开关 / 连接应用 / 聊天工具在全局设置的「咕咕」组。)
- 快速聊天(全局快捷键叫出的小窗)整个在壳那一侧:`components/assistant/QuickChatHost.tsx` 预开一扇同源子窗、把 `QuickChat` 画进去;快捷键 / 显隐 / 位置归主进程 `electron/quick-chat-window.ts`,契约 `lib/quickChatIpc.ts`。
- 开通:设置「咕咕」里壳的 `AssistantOnboarding`(认识咕咕 → 住哪 → 开通);开通后它的页是助理 App。称呼与身份读账号上的(`lib/firstRun.ts`)。壳 snapshot 的 `member` / `preparing` / `assistantState` 给最左栏那一格写提示与转圈;App 还在装时那一格转圈读主进程的规则状态(`rulesPending`)。
- 要壳替这里做的事走 `getActions()`:`renameAssistant` / `openLook`(形象工坊)/ `refreshCloud`;填输入框走 `fillChatDraft`。
- 「健康」:`HealthBody`(assistant-health.tsx)留给手机,数据从手机本机 Health Connect 读。
- today.json(私聊文件夹里它写的那份)的格式在 `assistant-today-file.ts`(纯函数 + 单测);读它走主进程 `rpc.extensions.readChatFolderText`(`electron/.../extensions/chat-folder-text.ts`),❌ 叫醒云电脑。灵感面板 `assistant-ideas.tsx`、胶囊隐藏 `lib/assistantIdeas.ts`。

## 住哪、安家与搬家(owner 10-16)

- **住哪**:会员一键领取住云上(管家开宿主);非会员装在这台电脑上(`lib/assistantSetup.ts` 走与「新建 agent」同一条 saga,`member_key='assistant'`,工作目录 `<GUGU_HOME>/assistant`,主进程 `electron/assistant-home*.ts` 备家)。认它靠 `identity.agent_provisions` 标记,它此刻住哪以通讯录 `device_id` 为准(`lib/myAssistant.ts` 的 `homeDeviceId`)。云上与电脑上的说明 / 禁用工具 / 首个任务是同一份(`@gugu/core/shared/assistantPolicy`,管家与客户端共用)。
- **搬家**(全局设置「咕咕」页里「它住在哪」那一组 `components/assistant/AssistantMoveGroup.tsx` 只有几行;弹窗 `AssistantMoveDialog.tsx` 挂在壳上、状态在 `assistant-move-controller.ts`(模块级 —— 搬到中途「它住哪」翻面,设置页上那一组会换位置重挂,放组件里状态就丢);编排 `assistant-move.ts`,真接线 `assistant-move-wire.ts`,拷贝 `assistant-move-copy.ts`,都有单测):
  - 搬上云 = 先接过(管家 `POST /provision {assistant:{existing_agent_user_id}}`,库落定时切 `users.device_id`、给旧家发 `agent.retire`)再拷;搬回本机 = 先备好本机的家、先拷,最后才接过(blueprint `existing_agent_user_id`)。
  - 拷什么:记忆夹、技能、给助理的资料(按字节分块、核大小、软链接不跟)+ 说明里人写的那一段(新家的管家段不被盖);账号类授权是**剪切**(写进新家并读回核对后才撤旧家那一份,命令行那几家带不走、搬完重新连);已安排在接过之前读到手、新家重排。旧家文件一个字节不动,`agent.retire` 只拆运行时。
  - 中断可接着搬(日志 `gugu:assistant-move:<owner>`,不含凭据,**记着旧家是哪台**:接着搬时旧家以日志为准,❌ 读此刻「它住哪」—— 接过之后那已经是新家,会把新家的账号当旧家去撤);对面咕咕太老不认新动词(`unknown_method`)= 只搬文件、账号原样留着、如实说。
  - 旧家的助理在搬的这段时间里还在写:搬上云是接过(旧家停)之后才数、才拷;搬回本机在接过之后再补一遍变了的(`diffPlan`)。搬之前逐个试读一个字节(目录列表把指向别处的软链接当普通文件报)。新家已经连着同 id 的另一份凭据 = 不覆盖(`exists`),旧家那份留着。
  - 会员到期:云上的家留着,助理休息;设置里写「在休息 + 续费 / 搬回这台电脑」(搬回那一次的叫醒 `purpose:'move_out'` 管家放行、不计费)。

## 任务区

侧栏(`sidebar-store.ts`)从同一座桥拿到它的 id:它自己的会话不进任务区,它派的会话行上标「助理发起」。认法与这里的「任务」分段同一份(`assistant-lineage.ts`)。

## 语音笔记(`voice-notes/`)

录音笔记:聊天框「+」→ 录(`voice-recorder.ts`,5 分钟一段)→ 传到云电脑记忆夹 `voice-notes/<id>/` → 主进程以助理名义签票转写(`electron/voice-notes.ts`)→ 投给助理自己那条会话写 `summary.md`(`voice-note-jobs.ts`)。
文件格式在 `@gugu/core/shared/voiceNotes`(手机照它写);录音条 `voice-recording-bar.tsx`;App 经 #1927 (47) `gugu.voiceNote` 要录、会议提醒(`components/assistant/MeetingReminder.tsx`)开录都走 `app-voice-note-host.ts`,录着时它在桥上登记(`setVoiceNoteHandler`),栏上红点据此知道在录。

手机(`mobile/assistant/phoneVoice*.ts` + `PhoneVoiceBar.tsx`)只做前半:录音在 WebView 里收 PCM 直接写 16k 单声道 `.wav`(`phoneVoicePcm.ts` / `phoneVoiceRecorder.ts`;❌ MediaRecorder,安卓 WebView 里它只吐 webm),分段传到同一个 `voice-notes/<id>/audio/`,全传上去后 `note.json` 标 `uploaded`(视图 queued,列表「等转写」)就停 —— 手机 ❌ 转写、❌ 签票、❌ 交总结。桌面的「开始转写」(App 经 47 的重试)就是 `retryVoiceNote(id)`:从 note.json 重建任务、读回云上的音频、转写、交给助理写总结。它在休息 / 连不上时手机 ❌ 替人叫醒:录音先留在手机 IndexedDB(`phoneVoiceBacklog.ts`),录音条说清并给「叫醒它」,醒了自己接着传;进程被杀后 `restore` 按记录接着传。只在咕咕前台时录(清单里「后台守着」的前台服务不带 microphone 类型)。
