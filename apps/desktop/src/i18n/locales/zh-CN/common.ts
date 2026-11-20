export default {
  "startup": {
    "slogan": "别自己做，让 AI 来。"
  },
  "staleRead": {
    "failed": "无法获取最新内容，当前显示上次读取的结果。",
    "retry": "重试"
  },
  "menu": {
    "search": "搜索",
    "noResults": "无结果"
  },
  "agentName": {
    "naming": "正在生成名称…"
  },
  "needsYou": {
    "title": "需要你处理",
    "waitingTasks": "等待你处理的任务",
    "count": "需要你处理 · {{count}}",
    "loading": "正在读取请求…",
    "sourceTask": "来自任务 · {{title}}"
  },
  "actions": {
    "copiedAgentId": "已复制 Agent ID",
    "copiedGuguNumber": "已复制咕咕号",
    "copiedLink": "已复制链接",
    "copy": "复制",
    "copyFailed": "复制失败"
  },
  "cloudComputer": {
    "reason": {
      "plan_required": "你的咕咕需要 Plus 及以上套餐。",
      "credits_exhausted": "积分已用完。",
      "membership_expired": "会员已到期，云端资源已停用。请续费，或将其迁移到你自己的电脑。",
      "timeout": "两分钟内未能建立连接。",
      "network": "无法连接咕咕服务，请检查网络后重试。",
      "signed_out": "登录已失效，请重新登录后重试。",
      "gone": "你的咕咕已关闭。",
      "failed": "你的咕咕运行出错。",
      "server_install_failed": "云端服务安装失败，请重试。",
      "server_start_failed": "云端服务启动失败，请重试。",
      "account_offline": "云端账号无法上线，请重试。",
      "package_update_pending": "更新将在当前任务结束后进行，请稍后重试。",
      "home_restore_failed": "无法恢复之前的数据，请稍后重试。",
      "host_unconfirmed": "暂时无法确认云主机状态，请稍后重试。",
      "assistant_create_failed": "助理创建失败，请重试。",
      "assistant_busy": "助理正忙，请稍后重试。",
      "login_expired": "云端登录已失效，需要重新授权。",
      "device_removed": "云端设备已被移除，需要确认后恢复。",
      "provision_incomplete": "开通未完成，请重试。",
      "wake_incomplete": "准备未完成，请稍后重试。",
      "sleep_incomplete": "操作未完成，请稍后重试。",
      "close_incomplete": "关闭未完成，请重试。"
    }
  },
  "connection": {
    "online": "在线",
    "connecting": "连接中",
    "deviceOffline": "设备离线",
    "lastSeen": "最后在线 {{time}}",
    "retry": "重新连接"
  },
  "agentStatus": {
    "running": "运行中",
    "parked": "后台运行中",
    "needsApproval": "等你批准",
    "needsAnswer": "等你回答",
    "needsPlanReview": "等你看计划",
    "needsAction": "需要你处理",
    "error": "出错了",
    "done": "做完了",
    "idle": "空闲",
    "online": "在线",
    "offline": "离线",
    "archived": "已归档",
    "removed": "已移除",
    "pending": "确认中",
    "starting": "启动中",
    "none": "状态不可用"
  },
  "agentShare": {
    "guguNumber": "咕咕号",
    "close": "关闭",
    "dialog": "分享 {{name}}",
    "generatePoster": "生成名片海报",
    "inviteLink": "邀请链接",
    "numberUnassigned": "未分配",
    "copied": "已复制",
    "copyRow": "复制{{label}}",
    "makePublic": "开启公开",
    "makingPublic": "正在开启…",
    "makePublicHint": "开启公开后才有咕咕号和邀请链接",
    "makePublicFailed": "开启公开失败",
    "title": "分享 Agent"
  },
  "brand": {
    "documentTitle": "咕咕"
  },
  "dialog": {
    "close": "关闭对话框",
    "label": "对话框"
  },
  "errors": {
    "offline": "网络连接失败，请检查网络后重试",
    "operationFailed": "操作失败，请稍后重试",
    "permissionDenied": "你没有执行此操作的权限"
  },
  "locale": {
    "enUS": "English",
    "label": "语言",
    "system": "跟随系统",
    "zhCN": "简体中文"
  },
  "relativeTime": {
    "daysAgo": "{{count}} 天前",
    "daysAgo_one": "{{count}} 天前",
    "daysAgo_other": "{{count}} 天前",
    "hoursAgo": "{{count}} 小时前",
    "hoursAgo_one": "{{count}} 小时前",
    "hoursAgo_other": "{{count}} 小时前",
    "justNow": "刚刚",
    "minutesAgo": "{{count}} 分钟前",
    "minutesAgo_one": "{{count}} 分钟前",
    "minutesAgo_other": "{{count}} 分钟前"
  },
  "toast": {
    "dismiss": "关闭提示"
  },
  "tabs": {
    "pending": "{{label}}，{{count}} 条待处理",
    "pending_one": "{{label}}，{{count}} 条待处理",
    "pending_other": "{{label}}，{{count}} 条待处理"
  }
} as const;
