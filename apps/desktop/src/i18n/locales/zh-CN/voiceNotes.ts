export default {
  "title": "语音笔记",
  "untitled": "语音笔记",
  "record": "录制语音笔记",
  "week": {
    "thisWeek": "本周",
    "lastWeek": "上周"
  },
  "delete": "删除",
  "deleteTitle": "删除“{{name}}”？",
  "deleteBody": "此操作无法撤销。",
  "deleteFailed": "无法删除这条语音笔记，请重试。",
  "phase": {
    "recording": "正在录音…结束后{{name}}将整理内容。",
    "uploading": "正在上传…{{name}}会在语音笔记准备好后通知你。",
    "transcribing": "正在转写…{{name}}会在语音笔记准备好后通知你。",
    "summarizing": "正在生成语音笔记…准备好后，{{name}}会通知你。"
  },
  "failure": {
    "upload": "无法上传音频，请检查网络连接。",
    "transcribe": "音频转写失败，请稍后重试。",
    "summarize": "{{name}}无法生成总结，请稍后重试。",
    "unreadable": "无法读取这条语音笔记。",
    "code": {
      "signed-out": "咕咕登录已失效，请重新登录后重试。",
      "membership-required": "转写语音笔记需要开通会员。",
      "model-unavailable": "转写服务暂时不可用，请稍后重试。",
      "team-monthly-cap-reached": "你本月的团队积分额度已用完，仅暂停你的 AI 使用，其他成员不受影响。请联系管理员调高上限。",
      "team-credits-exhausted": "团队积分已用完，所有成员暂时无法使用 AI。请联系管理员充值。",
      "unreachable": "无法连接咕咕模型服务，请检查网络后重试。",
      "service-unavailable": "咕咕服务出错，请稍后重试。"
    }
  },
  "retry": "重试",
  "bar": {
    "starting": "正在开始录音…",
    "cancel": "取消",
    "recording": "正在录音",
    "paused": "已暂停",
    "pause": "暂停录音",
    "resume": "继续录音",
    "stop": "结束录音",
    "noSound": "未检测到声音",
    "noSoundDescription": "请检查麦克风和音频输入。",
    "uploading": "正在处理音频…",
    "transcribing": "正在转写音频…",
    "summarizing": "正在生成语音笔记…",
    "ready": "语音笔记已生成",
    "open": "查看语音笔记",
    "noSpeech": "本次未录到可识别的声音",
    "failed": "录音未完成",
    "failedUpload": "无法上传音频，请检查网络连接。",
    "failedTranscribe": "音频转写失败",
    "failedSummarize": "语音笔记生成失败",
    "close": "关闭",
    "discard": "放弃录音",
    "discardTitle": "放弃这段录音？",
    "discardBody": "已录下的内容不会保存。",
    "discardConfirm": "放弃",
    "discardFailed": "无法放弃录音，请重试。",
    "heldKept": "录音已暂存在手机上。",
    "sending": "正在上传到{{name}}的运行设备…",
    "uploaded": "已上传到{{name}}的运行设备，等待转写"
  },
  "mic": {
    "denied": "请在设置中授权麦克风权限",
    "permissions": "管理权限",
    "openSettings": "打开系统设置",
    "deniedPhone": "麦克风未开启，请在“我的 → 本机控制”中开启。",
    "missing": "未找到麦克风，请连接后重试。",
    "failed": "无法开始录音，请重试。",
    "interrupted": "录音已中断，已录制的部分将继续处理。",
    "busy": "正在录另一条语音笔记。"
  },
  "meeting": {
    "heading": "会议即将开始",
    "startRecording": "开始录音",
    "recording": "正在录制中",
    "error": "无法开始录制，请重试。",
    "setting": "入会提醒",
    "settingDescription": "本机日历中的会议即将开始时，提醒你录音。",
    "needsCalendar": "请先在「连接应用 → 本机」中连接日历。",
    "calendarUnreadable": "无法读取本机日历。"
  }
} as const;
