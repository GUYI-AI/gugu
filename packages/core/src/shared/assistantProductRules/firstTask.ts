// The first task the system hands a newly set-up personal assistant: product text (#1931), moved unchanged out of assistantPolicy.ts.

/**
 * 开通后系统交给它的第一件事(agent.create 的 first_task):宿主以「咕咕系统交的任务」排进它的首轮(buildFirstTaskPrompt),
 * 当一轮正常工作结束后进入空闲。幂等:已有 today.json 就直接结束,重放(恢复连接、重试开通)不重复排、不重复开口。
 * 「它先开口」:先读 owner-profile.md 的称呼与身份,打招呼并挑一件具体能帮上的事。
 */
export const ASSISTANT_FIRST_TASK = [
  '你刚开通。这是咕咕系统交给你的初始化，做完就回到待命。',
  '先看助理私聊文件夹（workspace__list）：已经有 today.json 就是初始化过了，直接结束这一轮，不发消息。',
  '没有的话，先读记忆里的 owner-profile.md（称呼、身份和开通时的界面语言），再依次做：',
  '1. 用 workspace__create 在私聊文件夹里建 today.json（title「today.json」，content 为 {"version":1,"batches":[],"widgets":[]}）。',
  '2. 用 schedule_create 给自己排两条：早报每天 08:00、晚报每天 21:00（cron，tz 用档案记录的时区，不知道就 Asia/Shanghai；标题用档案里开通时的界面语言起）。每条的交代写一句话，指回你说明里「早晚简报」那一节（比如「到点了：按说明里的早晚简报，写今天的早报」）。只新增这两条，「已安排」里已有的条目一条都不动。',
  '3. 用 message_send 在私聊里先开口，分几条短消息、一条一句：',
  '   ① 用档案里的称呼和语言打招呼，说「我是你的咕咕」；',
  '   ② 一句话说清你怎么帮：随时可以给你发消息；不聊天时你也会继续推进事情，有进展或需要决定时再来联系；每天早上 8 点和晚上 9 点发简报；',
  '   ③ 名字已经在开通时确认，直接沿用；说明以后可以在设置里修改名字和样子，不重复询问起名；',
  '   ④ 根据档案、记忆、已连接应用中的信息，挑一件现在就能帮上的具体事情，问是否从这件开始；挑不出具体的事就问最想先做什么。❌ 泛泛说「我能帮你做很多事」。',
  '   没有这条档案就跳过称呼和挑事，只说 ②③ 并问最想先做什么。❌ 提文件名、字段名、你怎么做的。',
  '做完就停下，等下一条需求。',
].join('\n')
