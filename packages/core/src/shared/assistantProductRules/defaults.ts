// Product defaults of the personal assistant (#1931: product rules, moved out of assistantPolicy.ts / assistantWorkflow.ts unchanged).

/**
 * 它开子 agent 不指定 harness 时用哪个(agent.create 的 child_harness):子 agent 默认 Claude Code。
 * ❌ 写进说明让它记得传,❌ 从住在哪推断 —— 这是这个 agent 的显式配置。
 */
export const ASSISTANT_CHILD_HARNESS = 'claude'

/** 新开通的个人助理默认用快速模型;既有助理和用户手动选择的模型不随默认值变化。 */
export const ASSISTANT_DEFAULT_MODEL = 'platform:glm-5.3-flash'

/** Claude Code 自带的定时(CronCreate)仅在进程存活时有效,宿主不可见。按工具名禁掉,定时一律走 schedule_create。 */
export const ASSISTANT_DENIED_TOOLS: readonly string[] = ['CronCreate']

// Bump when the owner-profile writing rules change, so existing accounts recheck on their next conversation.
export const PROFILE_RULES_VERSION = 6
