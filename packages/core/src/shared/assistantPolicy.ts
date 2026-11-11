/**
 * #7199 个人助理的「工作说明」与开通时交给它的几样东西 —— 住云上(管家写)与住人自己的电脑上(客户端写)共用这一份。
 *
 * 来源:管家 services/cloud-computer(gugu-supabase)里的 ASSISTANT_GUIDE / ASSISTANT_FIRST_TASK / ASSISTANT_CHILD_HARNESS,
 * owner 10-16「不强制用户使用云电脑」之后搬到这里两边共用；管家那边的副本从这里生成，不再手抄另一份说明。
 *
 * #1931 这里只有宿主的机制(标记、写回、路径、拼装)。说明的文字与产品默认值是产品的:由助理 App 提供(经桌面宿主的解析器读到),
 * 不在这个仓里;格式与槽位在 ./assistantRulesFormat。每个拼装函数都要显式收一份 rules,没有内置默认。
 *
 * 只放字符串与纯函数(管家跑在 Deno / Node,客户端主进程与渲染层都会 import),❌ 碰 node / electron。
 */
import { renderAssistantRule, type AssistantProductRules } from './assistantRulesFormat'

/** 宿主维护段的头尾:标记外自定义文字照留,标记内每次开通 / 恢复连接(本机:每次启动)整段覆盖。 */
export const ASSISTANT_GUIDE_BEGIN = '<!-- 咕咕管家维护这一段,改了会被覆盖;写在这段外面的会保留 -->'
export const ASSISTANT_GUIDE_END = '<!-- /咕咕管家 -->'
/** 早先的标记带着「云电脑」(助理读得见,owner 10-15 定了对用户完全不可见):认出旧标记的那一段就地换成新的。 */
export const LEGACY_ASSISTANT_GUIDE_BEGIN = '<!-- 咕咕云电脑:管家维护这一段,改了会被覆盖;写在这段外面的会保留 -->'
export const LEGACY_ASSISTANT_GUIDE_END = '<!-- /咕咕云电脑 -->'

/** 运行位置:按需伸缩的云端 / 已连接的本机。身份说明与调度说明按位置区分。 */
export type AssistantHomeKind = 'cloud' | 'computer'

/** The host's values for the brief's and recovery notice's path slots. */
function homeSlots(memoryDir: string): Record<string, string> {
  return { memoryIndex: join(memoryDir, 'MEMORY.md'), workingContext: join(memoryDir, 'working-context.md'), pendingWork: join(memoryDir, 'pending-work.json') }
}

/** Rehydrate pointers after native context reconstruction; task state and personal text stay at their source. */
export function assistantRecoveryContext(memoryDir: string, rules: AssistantProductRules): string {
  return ['<gugu_assistant_recovery>', renderAssistantRule(rules.texts.recovery, homeSlots(memoryDir)), '</gugu_assistant_recovery>'].join('\n')
}

/** The resident brief in the managed block: the product's words, the host's markers and paths. */
export function assistantBrief(kind: AssistantHomeKind, reference: string, memoryDir: string, rules: AssistantProductRules): string {
  return [
    ASSISTANT_GUIDE_BEGIN,
    renderAssistantRule(rules.texts[`brief-${kind}`], { ...homeSlots(memoryDir), reference }),
    ASSISTANT_GUIDE_END, '',
  ].join('\n')
}

/** 一份完整的说明(连头尾标记)。 */
export function assistantGuide(kind: AssistantHomeKind, rules: AssistantProductRules): string {
  return [
    ASSISTANT_GUIDE_BEGIN,
    renderAssistantRule(rules.texts[`guide-${kind}`], { profileRulesVersion: String(rules.defaults.profileRulesVersion) }),
    ASSISTANT_GUIDE_END,
    '',
  ].join('\n')
}

/**
 * 把说明写进那份文件(Claude Code 的 CLAUDE.md、Pi 的 AGENTS.md)的全文:有标记(新 / 旧)就只换标记那一段,
 * 早期整份都是管家写的(以「# 你是谁」开头)就整份换,否则接在末尾。与管家 POLICY_PY 的 put() 同一规则。
 */
export function upsertAssistantGuide(old: string, guide: string): string {
  const marks: Array<[string, string]> = [
    [ASSISTANT_GUIDE_BEGIN, ASSISTANT_GUIDE_END],
    [LEGACY_ASSISTANT_GUIDE_BEGIN, LEGACY_ASSISTANT_GUIDE_END],
  ]
  const hit = marks.find(([begin, end]) => old.includes(begin) && old.includes(end))
  if (hit) {
    const start = old.indexOf(hit[0])
    const end = old.indexOf(hit[1], start) + hit[1].length
    return old.slice(0, start) + guide.replace(/\n+$/, '') + old.slice(end)
  }
  if (old.startsWith('# 你是谁')) return guide
  return (old.trim() ? `${old.replace(/\n+$/, '')}\n\n` : '') + guide
}

/** 引导中填写的「称呼和基本信息」保存为记忆(Claude Code frontmatter + 正文),与管家写的同名同格式。 */
export const OWNER_PROFILE_MEMORY_FILE = 'owner-profile.md'
/** MEMORY.md 里指向它的那一行。 */
export function ownerProfileIndexLine(rules: AssistantProductRules): string {
  return `- [${rules.labels.ownerProfileMemoryName}](${OWNER_PROFILE_MEMORY_FILE}) — ${rules.labels.ownerProfileIndexDescription}`
}

/** 引导中填写的称呼与自我介绍(可空)。 */
export type OwnerProfileInput = { preferredName: string; about: string }

/** 交给管家 / 写进记忆的那一段 markdown(只有正文,不带 frontmatter)。 */
/** language = 开通时的界面语言:对话开始前,问候与起名跟它;开始后跟对方在用的语言。 */
export function ownerProfileMarkdown(input: OwnerProfileInput & { language: string }, rules: AssistantProductRules): string {
  const name = input.preferredName.trim()
  const about = input.about.trim()
  return [...(about ? [about, ''] : []), renderAssistantRule(rules.labels.ownerProfileNameLine, { preferredName: name }),
    renderAssistantRule(rules.labels.ownerProfileLanguageLine, { language: input.language })].join('\n')
}

/** 记忆夹里那一条的全文。 */
export function ownerProfileMemoryFile(markdown: string, rules: AssistantProductRules): string {
  return [
    '---',
    `name: ${rules.labels.ownerProfileMemoryName}`,
    `description: ${rules.labels.ownerProfileMemoryDescription}`,
    'type: user',
    '---',
    '',
    markdown.trim(),
    '',
  ].join('\n')
}

/** MEMORY.md 补上那一行(已有就不重复;没有索引就新建)。 */
export function withOwnerProfileIndex(index: string | null, rules: AssistantProductRules): string {
  const current = index ?? ''
  if (current.includes(`](${OWNER_PROFILE_MEMORY_FILE})`)) return current
  return (current.trim() ? `${current.replace(/\n+$/, '')}\n` : '') + `${ownerProfileIndexLine(rules)}\n`
}

/** Claude Code 给一个工作目录起的目录名(`/home/wuying` → `-home-wuying`):非字母数字一律换成 `-`。 */
export function claudeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

/** 人放给助理看的资料放在这一夹(「添加与你有关的文件」)。 */
export const ASSISTANT_RESOURCES_DIR_NAME = '给助理的资料'

/**
 * 住电脑时它的工作目录在咕咕自己的目录里(`<咕咕目录>/assistant`)。❌ 用中文名:Claude Code 的记忆夹按目录名「非字母数字换成 -」
 * 起名,人电脑上任何一个同样长短的中文目录(`~/文档` 与 `~/助理`)都会撞进同一个记忆夹。
 */
export const ASSISTANT_COMPUTER_WORKDIR_NAME = 'assistant'

export type AssistantHomePaths = {
  /** 它每次开工读的说明(宿主维护的那段 + 人写的性格)。 */
  instructions: string
  /** 读写它记忆用的那个目录。 */
  memoryDir: string
  /** Claude Code 自己认的记忆夹(`~/.claude/projects/<目录名>/memory`)。住电脑时它是指向 memoryDir 的链接(见 assistantHomePaths)。 */
  claudeMemoryDir: string
  memoryIndex: string
  skillsDir: string
  /** Claude Code 的设置(禁用的工具)。 */
  settings: string
  resourcesDir: string
}

/**
 * 它家里那几样在哪:
 * - 云上:那台整台都是它的,说明 / 技能 / 设置都在 `~/.claude`(管家写的就是这几处),记忆在 Claude Code 按工作目录记的那一夹,资料夹在主目录;
 * - 本机:`~/.claude` 是个人 Claude Code 的配置(每个会话都读),❌ 往里写 —— 助理配置都在它的工作目录里:
 *   说明、技能、设置是 Claude Code 的项目级那几样(CLAUDE.md、.claude/skills、.claude/settings.json),记忆在 `.claude/memory`,
 *   Claude Code 认的那一夹(`~/.claude/projects/<目录名>/memory`)链到这里。整个家一个目录:读写 / 删除都落在它的工作区里
 *   (工作区之外的删、改名、分块上传会被拦),搬家也只拷这一个目录。
 */
export function assistantHomePaths(home: string, workdir: string, kind: AssistantHomeKind): AssistantHomePaths {
  const claude = join(home, '.claude')
  const claudeMemoryDir = join(join(join(claude, 'projects'), claudeProjectDirName(workdir)), 'memory')
  const base = kind === 'cloud' ? claude : join(workdir, '.claude')
  const memoryDir = kind === 'cloud' ? claudeMemoryDir : join(base, 'memory')
  return {
    instructions: kind === 'cloud' ? join(claude, 'CLAUDE.md') : join(workdir, 'CLAUDE.md'),
    memoryDir,
    claudeMemoryDir,
    memoryIndex: join(memoryDir, 'MEMORY.md'),
    skillsDir: join(base, 'skills'),
    settings: join(base, 'settings.json'),
    resourcesDir: join(kind === 'cloud' ? home : workdir, ASSISTANT_RESOURCES_DIR_NAME),
  }
}

/** settings.json 补上禁用的工具(已有的设置、已有的禁用项照留)。读不懂原文 = 抛(❌ 盖掉人写的设置)。 */
export function withDeniedTools(raw: string | null, deniedTools: readonly string[]): string {
  const settings = raw?.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json is not a JSON object')
  const permissions = (settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {}) as Record<string, unknown>
  const deny = Array.isArray(permissions.deny) ? [...(permissions.deny as unknown[])] : []
  for (const tool of deniedTools) if (!deny.includes(tool)) deny.push(tool)
  return `${JSON.stringify({ ...settings, permissions: { ...permissions, deny } }, null, 2)}\n`
}
