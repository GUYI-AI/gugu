// How the personal assistant's owner-profile memory and its review are worded: product text (#1931), moved unchanged out
// of assistantPolicy.ts and sessionpage/assistant-profile-review.ts. File names, structure and the review trigger stay with the host.

/** 引导中填写的「称呼和基本信息」保存为记忆(Claude Code frontmatter + 正文)的名字;也是 MEMORY.md 里那一行的链接文字。 */
export const OWNER_PROFILE_MEMORY_NAME = '基本信息'
// 人与助理共读的字段不带身份称谓,也不用「你 / 我」这类两头读法相反的代词。
export const OWNER_PROFILE_MEMORY_DESCRIPTION = '开通时填的称呼和基本信息'
/** MEMORY.md 里那一行链接之后的说明。 */
export const OWNER_PROFILE_INDEX_DESCRIPTION = '称呼和基本信息'
/** 档案正文里的称呼一行与界面语言一行(language = 开通时的界面语言:对话开始前,问候与起名跟它;开始后跟对方在用的语言)。 */
export const OWNER_PROFILE_NAME_LINE = '称呼：{{preferredName}}'
export const OWNER_PROFILE_LANGUAGE_LINE = '开通时的界面语言：{{language}}'

/** Inside `<gugu_profile_review>`, before an owner turn while owner-profile.md is not recorded as reviewed under the current rules. */
export const ASSISTANT_PROFILE_REVIEW = '需回复时先用message_send按信封回复，再整理，不再发消息。读owner-profile.md：「你」开头，几句已证身份、近况、作息；未知省略，禁标题及mtime推测。仅留「称呼：姓名」，其余称呼原话、助理规矩全删，勿记忆。禁「他」；其他本人确认约定移feedback并索引。保留事实、日期、来源；依据放末节。回读合规才在MEMORY.md原行记profile_rules:{{profileRulesVersion}}并回读；失败不记。'
/** Added before the review when the host could not read the profile or its index. */
export const ASSISTANT_PROFILE_REVIEW_UNVERIFIED = '未核。'
