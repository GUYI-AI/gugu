import { SUPPORTED_LOCALES, type SupportedLocale } from '@/i18n/locale'

// @@@host-system-languages — 宿主真实系统语言列表的同步取值通道(sendSync)。renderer 在首帧之前
// (preload 加载时)就要拿到它,所以是同步的:异步 IPC 会让第一帧退回 navigator 语言、再闪换成宿主语言,
// 违反 localization spec「首帧跟随宿主语言、不闪换」。main 侧答以 app.getPreferredSystemLanguages()。
export const HOST_SYSTEM_LANGUAGES_CHANNEL = 'host-locale:get-system-languages'

export interface WindowChromeLabels {
  minimize: string
  maximize: string
  restore: string
  close: string
}

const HOST_CATALOG = {
  'zh-CN': {
    browserFeedback: {
      operating: '正在操作网页',
      finished: '网页操作已结束',
      running: {
        move: '正在移动光标', scroll: '正在滚动', click: '正在点击', type: '正在输入',
        key: '正在按键', navigate: '正在打开网页', reload: '正在刷新网页', view: '正在查看网页',
      },
      done: {
        move: '已移动光标', scroll: '已滚动', click: '已点击', type: '已输入',
        key: '已按键', navigate: '已打开网页', reload: '已刷新网页', view: '已查看网页',
      },
    },
    teamPaymentTitle: '团队积分充值',
    fatalBoot: {
      title: '咕咕无法启动：任务页启动失败',
    },
    /** 主进程答给界面、界面原样显示的那一句(electron/main.ts、model-access.ts、macDmgUpdater.ts)。 */
    hostErrors: {
      agentNotOnDevice: '这个 Agent 不在当前设备上运行。',
      modelSessionUnknown: '模型默认已更新，但暂时无法确定该 Agent 的当前会话（{detail}）。请稍后重试。',
      modelRuntimeUnavailable: '模型默认已更新，但任务页运行时不可用，当前会话未能切换。',
      agentRuntimeNotConnected: 'Agent 运行时尚未连接。',
      engineWithoutGuguModels: '这个 Agent 的引擎不支持咕咕提供的模型。',
      guguModelNotOpen: '这个咕咕模型尚未对当前 Agent 开放（{model} / {protocol}）。',
      membershipRequired: '咕咕 {model} 需要开通会员。',
      shareAgentUnavailable: '该任务暂无可分享的 Agent 身份。',
      taskRuntimeUnavailable: '任务页运行时不可用。',
      linkedSessionMissing: '映射的任务或会话已不存在。',
      updateFilesMissing: '没有可用的更新文件信息，请先检查更新。',
      updateOpenFailed: '无法打开安装包：{detail}',
      updateUnsupportedArch: '不支持此 Mac 的架构 {arch}，安装包只有 arm64 和 x64 两种。',
      updateInstallerMissing: '更新清单中没有 {arch} 架构的安装包（{files}）。',
    },
    /** 密码本(electron/password-vault)。pullTitle = 另一台设备申请用这里的密码时的系统通知;verifyReason 由 macOS 拼进指纹框。 */
    passwordVault: {
      pullTitle: '「{device}」想用你的密码',
      pullNewDevice: '新设备',
      pullBody: '打开咕咕，核对两台设备上的数字。',
      verifyReason: '查看已保存的密码',
    },
    tray: {
      tooltip: '咕咕',
      show: '打开咕咕',
      quit: '退出咕咕',
    },
    /** mac 菜单栏「咕咕」那一栏里自己加的项(其余是系统 role,系统自己翻)。 */
    appMenu: {
      settings: '设置…',
    },
    fileViewerMenu: {
      copy: '复制', selectAll: '全选', comment: '评论',
      undo: '撤销', redo: '重做', cut: '剪切', paste: '粘贴',
    },
    notifications: {
      closeToTray: {
        title: '咕咕 仍在后台运行',
        body: '点击咕咕图标或重新打开应用以恢复窗口；如需退出，请在图标菜单中选择「退出咕咕」。',
      },
      authExpired: {
        title: '咕咕登录已失效，请在该设备重新登录',
        body: '该设备的咕咕会话已失效，已停止上线；重新登录后会自动恢复。',
      },
    },
    windowChrome: {
      minimize: '最小化',
      maximize: '最大化',
      restore: '还原',
      close: '关闭',
    },
    barcodeScan: {
      hint: '将二维码放入框内',
      cancel: '取消',
    },
    /** 安卓通知渠道名 —— 用户在系统「设置 → 应用 → 咕咕 → 通知」的类别列表里看到的名字(product spec)。 */
    notificationChannels: {
      alerts: '提醒',
      quiet: '静音提醒',
    },
    /**
     * 「后台守着」那条常驻通知的第二行(product spec)。标题由渲染层给(在看管几台机器),
     * 这一行回答「它凭什么常驻在我的通知栏里」—— 说给用户的好处,不说前台服务这类机制。
     * ⚠️ 必须给:不给的话插件会填它自带的默认句 "App will start faster" ——
     * 一句英文,而且讲的是它作者关心的事(2026-09-16 在模拟器通知栏里实际看到)。
     */
    backgroundWatch: {
      text: '有人需要你回复时及时通知你',
    },
    /**
     * 会话页那一侧(electron/session/main)写给人看的字,由宿主整块注入(session/main/core/host-copy.ts)。
     * @@@5301 agentNotifications = 会话页 agent 的系统通知正文(agent-hooks/notification.ts),与上面 notifications
     * 那条(聊天/托盘)彼此独立。integrations / sessionOptions = 设备答给界面、界面原样显示的那一句(设备说的话,
     * 用设备的语言)。
     */
    sessionHost: {
      agentNotifications: {
        needsApproval: '智能体需要你批准',
        needsAnswer: '智能体正在等待你回答',
      },
      integrations: {
        notCommandLine: '这个应用不使用命令行连接。',
        notImplemented: '这个集成尚未在这台设备上实现，请选择其他设备。',
        integrityFailed: '下载的工具校验未通过，请重试安装。',
        permissionDenied: '没有权限访问集成工具的目录，请检查目录权限后重试。',
        diskFull: '磁盘空间不足，请清理后重试。',
        secureStorage: '无法保存授权信息，请检查安全存储后重试。',
        timeout: '连接超时，请检查网络后重试。',
        installFailed: '集成工具安装失败，请检查网络后重试。',
        installFailedRetry: '集成工具安装失败，请重试。',
        loginStartFailed: '未能启动授权，请检查网络后重新连接。',
        verifyFailed: '未能确认授权状态，请重新连接。',
        connectionCancelled: '本次连接已取消。',
        noPendingAuthorization: '没有正在进行的授权，请重新连接。',
        authorizationCancelled: '授权已取消。',
        authorizationExpired: '授权已过期，请重新连接。',
        authorizationIncomplete: '尚未完成授权，请重新连接。',
        feishuPersonalUnconfirmed: '飞书未能确认个人账号的授权，请重新连接。',
        authorizationInvalid: '授权已失效，请重新连接。',
      },
      sessionOptions: {
        noRuntime: '这台机器上没有运行中的 ACP 会话，无法修改选项。',
        notRunning: '这条会话未在运行，运行后才能修改选项。',
        fastUnsupported: '当前模型不支持 Fast 模式。',
        dimensionUnsupported: '这条会话没有可修改的选项：{dimension}。',
        valueUnavailable: '{value} 不在可选清单中。',
        failedWithoutReason: '修改选项失败，provider 未说明原因。',
      },
    },
    /** #6387 点了一条 gugu://ext 链接却没打开时,告诉人为什么。{name} = 扩展名(没装时是它的 id)。 */
    extensionLinks: {
      title: '无法打开链接',
      notInstalled: '此链接需要打开 App「{name}」,但该 App 未安装。',
      disabled: '此链接需要打开「{name}」,但它已停用。请在左栏「App」中启用。',
      noSuchTab: '「{name}」中没有此链接指向的页面,链接可能来自其他版本。',
      noSession: '此链接需要在任务中打开「{name}」,但该任务不在这台电脑上。',
      openFailed: '无法打开「{name}」:{detail}',
    },
    /**
     * @@@touchid-passkey 内置浏览器的 Touch ID 通行密钥(electron/macWebAuthn.ts)。touchIdReason 由 macOS 拼进系统指纹框:
     * 「"咕咕"正在尝试<这一句>」,`$1` 换成网站域名。chooseAccount = 同一网站存着多把时让人选。
     */
    webAuthn: {
      touchIdReason: '在 $1 上验证你的身份',
      chooseAccount: {
        message: '用哪个账号登录 {site}?',
        detail: '这台 Mac 上的咕咕里存着 {site} 的多把通行密钥。',
        cancel: '取消',
      },
    },
    /** 主窗口的页面几分钟内连着崩了好几次、不再自动重新载入时,当面说的话(electron/renderer-crash-recovery.ts)。{count} = 次数。 */
    rendererCrash: {
      title: '咕咕的界面反复出错',
      detail: '界面在几分钟内连续崩溃了 {count} 次,已停止自动重新载入。',
      reload: '重新载入',
      quit: '退出咕咕',
    },
    updateRestart: {
      title: '重启更新？',
      one: '{count} 个正在运行的任务会被中断。',
      other: '{count} 个正在运行的任务会被中断。',
      unknown: '正在运行的任务会被中断。',
      restart: '现在重启',
      later: '稍后',
    },
    sessionPlatform: {
      /**
       * 会话跑到一半、咕咕额度的凭据签不出来时,agent 自己界面上显示的那一句(claude 显示为
       * `apiKeyHelper failed: exited 1: <这一句>`,codex / opencode 显示为请求被拒的原因)。
       * 句首带「咕咕」:这一行夹在 agent 自己的报错里,得让人认得出是谁说的。
       */
      credentialUnavailable: {
        signedOut: '咕咕:登录已失效。请在咕咕中重新登录后重新发送',
        modelUnavailable: '咕咕:该模型当前不可用。请切换模型后重新发送',
        membership: '咕咕:当前使用的咕咕模型需要开通会员。请切换模型或开通会员后重新发送',
        unreachable: '咕咕:无法连接咕咕服务。请稍后重新发送',
        serviceUnavailable: '咕咕:咕咕服务出错。请稍后重新发送',
        teamMonthlyCap: '你本月的团队积分额度已用完，仅暂停你的 AI 使用，其他成员不受影响。请联系管理员调高上限。',
        teamCredits: '团队积分已用完，所有成员暂时无法使用 AI。请联系管理员充值。',
      },
    },
  },
  'en-US': {
    browserFeedback: {
      operating: 'Working in the page',
      finished: 'Finished working in the page',
      running: {
        move: 'Moving the pointer', scroll: 'Scrolling', click: 'Clicking', type: 'Typing',
        key: 'Pressing a key', navigate: 'Opening the page', reload: 'Reloading the page', view: 'Reading the page',
      },
      done: {
        move: 'Moved the pointer', scroll: 'Scrolled', click: 'Clicked', type: 'Typed',
        key: 'Pressed a key', navigate: 'Opened the page', reload: 'Reloaded the page', view: 'Read the page',
      },
    },
    teamPaymentTitle: 'Team credit payment',
    fatalBoot: {
      title: 'Gugu cannot start: the task page failed to start',
    },
    hostErrors: {
      agentNotOnDevice: 'This agent does not run on this device.',
      modelSessionUnknown: "The default model was updated, but the agent's current session could not be determined ({detail}). Try again later.",
      modelRuntimeUnavailable: 'The default model was updated, but the task runtime is not available, so the current session was not switched.',
      agentRuntimeNotConnected: 'The agent runtime is not connected yet.',
      engineWithoutGuguModels: "This agent's engine does not support Gugu models.",
      guguModelNotOpen: 'This Gugu model is not available to this agent ({model} / {protocol}).',
      membershipRequired: 'Gugu {model} requires a membership.',
      shareAgentUnavailable: 'This task has no agent identity to share yet.',
      taskRuntimeUnavailable: 'The task runtime is not available.',
      linkedSessionMissing: 'The linked task or session no longer exists.',
      updateFilesMissing: 'No update file information is available. Check for updates first.',
      updateOpenFailed: 'Could not open the installer: {detail}',
      updateUnsupportedArch: "This Mac's architecture ({arch}) is not supported. Installers exist only for arm64 and x64.",
      updateInstallerMissing: 'The update manifest has no installer for {arch} ({files}).',
    },
    passwordVault: {
      // macOS renders `"Gugu" is trying to <this>`, so a lowercase fragment.
      pullTitle: '"{device}" wants to use your passwords',
      pullNewDevice: 'A new device',
      pullBody: 'Open Gugu and compare the numbers on both devices.',
      verifyReason: 'show saved passwords',
    },
    tray: {
      tooltip: 'Gugu',
      show: 'Open Gugu',
      quit: 'Quit Gugu',
    },
    appMenu: {
      settings: 'Settings…',
    },
    fileViewerMenu: {
      copy: 'Copy', selectAll: 'Select All', comment: 'Comment',
      undo: 'Undo', redo: 'Redo', cut: 'Cut', paste: 'Paste',
    },
    notifications: {
      closeToTray: {
        title: 'Gugu is still running in the background',
        body: 'Click the Gugu icon or reopen the app to restore it; to quit, choose Quit Gugu from the icon menu.',
      },
      authExpired: {
        title: 'Your Gugu sign-in expired',
        body: 'Gugu stopped running on this device. Sign in again to resume automatically.',
      },
    },
    windowChrome: {
      minimize: 'Minimize',
      maximize: 'Maximize',
      restore: 'Restore',
      close: 'Close',
    },
    barcodeScan: {
      hint: 'Place the QR code inside the frame',
      cancel: 'Cancel',
    },
    notificationChannels: {
      alerts: 'Alerts',
      quiet: 'Silent alerts',
    },
    /** 见 zh-CN 那条的说明:插件不给正文就会填一句英文默认句,所以这一行必须自己写。 */
    backgroundWatch: {
      text: 'Notifies you when someone needs your reply',
    },
    sessionHost: {
      agentNotifications: {
        needsApproval: 'Your agent needs your approval',
        needsAnswer: 'Your agent is waiting for your answer',
      },
      integrations: {
        notCommandLine: 'This app does not connect through a command-line tool.',
        notImplemented: 'This integration is not available on this device yet. Choose another device.',
        integrityFailed: 'The downloaded tool failed verification. Install it again.',
        permissionDenied: 'Gugu cannot access the integration tool folder. Check the folder permissions, then try again.',
        diskFull: 'The disk is full. Free up space, then try again.',
        secureStorage: 'The authorization could not be saved. Check the secure storage, then try again.',
        timeout: 'The connection timed out. Check the network, then try again.',
        installFailed: 'The integration tool could not be installed. Check the network, then try again.',
        installFailedRetry: 'The integration tool could not be installed. Try again.',
        loginStartFailed: 'The authorization could not start. Check the network, then connect again.',
        verifyFailed: 'The authorization status could not be confirmed. Connect again.',
        connectionCancelled: 'This connection was cancelled.',
        noPendingAuthorization: 'No authorization is in progress. Connect again.',
        authorizationCancelled: 'The authorization was cancelled.',
        authorizationExpired: 'The authorization expired. Connect again.',
        authorizationIncomplete: 'The authorization is not complete. Connect again.',
        feishuPersonalUnconfirmed: 'Feishu could not confirm the authorization of your personal account. Connect again.',
        authorizationInvalid: 'The authorization is no longer valid. Connect again.',
      },
      sessionOptions: {
        noRuntime: 'No ACP session is running on this machine, so options cannot be changed.',
        notRunning: 'This session is not running. Its options can be changed once it runs.',
        fastUnsupported: 'The current model does not support Fast mode.',
        dimensionUnsupported: 'This session has no option to change: {dimension}.',
        valueUnavailable: '{value} is not one of the available options.',
        failedWithoutReason: 'The option could not be changed. The provider gave no reason.',
      },
    },
    extensionLinks: {
      title: 'Could not open the link',
      notInstalled: 'This link opens the App "{name}", which is not installed.',
      disabled: 'This link opens {name}, which is turned off. Turn it on in Apps, in the left rail.',
      noSuchTab: '{name} has no page this link points to. The link may come from another version.',
      noSession: 'This link opens {name} in a task that is not on this computer.',
      openFailed: 'Could not open {name}: {detail}',
    },
    webAuthn: {
      // macOS renders `"咕咕" is trying to <this>`, so a lowercase fragment.
      touchIdReason: 'verify your identity on $1',
      chooseAccount: {
        message: 'Which account do you want to sign in to {site} with?',
        detail: 'Gugu on this Mac has more than one passkey for {site}.',
        cancel: 'Cancel',
      },
    },
    rendererCrash: {
      title: "Gugu's window keeps crashing",
      detail: 'The window crashed {count} times within a few minutes, so it is no longer reloaded automatically.',
      reload: 'Reload',
      quit: 'Quit Gugu',
    },
    updateRestart: {
      title: 'Restart to update?',
      one: '{count} running task will be interrupted.',
      other: '{count} running tasks will be interrupted.',
      unknown: 'Running tasks will be interrupted.',
      restart: 'Restart now',
      later: 'Later',
    },
    sessionPlatform: {
      credentialUnavailable: {
        signedOut: 'Gugu: you are signed out. Sign in again in Gugu, then resend',
        modelUnavailable: 'Gugu: this model is currently unavailable. Switch to another model, then resend',
        membership: 'Gugu: the Gugu model you are using needs a membership. Switch models, or get a membership, then resend',
        unreachable: 'Gugu: cannot reach the Gugu service. Resend later',
        serviceUnavailable: 'Gugu: the Gugu service returned an error. Resend later',
        teamMonthlyCap: 'You have used your monthly team credit limit. Only your AI use is paused; other members are not affected. Ask an administrator to raise your limit.',
        teamCredits: 'Team credits have run out. AI use is paused for everyone. Ask an administrator to top up.',
      },
    },
  },
} as const

export type HostCatalog = (typeof HOST_CATALOG)[SupportedLocale]

export function isResolvedLocale(value: unknown): value is SupportedLocale {
  return SUPPORTED_LOCALES.includes(value as SupportedLocale)
}

export function hostCatalog(locale: SupportedLocale): HostCatalog {
  return HOST_CATALOG[locale]
}

/** Fill `{name}` placeholders of a host catalog sentence. A placeholder without a value is a wiring error. */
export function hostText(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`host text is missing {${name}}`)
    return value
  })
}

export function updateRestartCopy(catalog: HostCatalog, count: number | null) {
  const copy = catalog.updateRestart
  return { ...copy, detail: count === null ? copy.unknown : (count === 1 ? copy.one : copy.other).replace('{count}', String(count)) }
}
