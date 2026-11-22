import { getCurrentAuthUserId } from './supabase'
import { readOwnSettings, updateOwnSettingsKey } from './ownSettings'
import {
  AGENT_CREATE_DEFAULTS_KEY,
  mergeAgentCreateProjectChoice,
  mergeAgentCreateRunMachine,
  parseAgentCreateDefaults,
  type AgentCreateDefaults,
} from '@gugu/core/shared/ui/agentCreateDefaultsModels'

// @@@per-user-create-defaults (#2525) — 规则全在 core（见 shared/ui/agentCreateDefaultsModels.ts）。
// 这份偏好是自己那一行 `user` 设置里的一个键(agent_create):读、写都经 lib/ownSettings,和首次引导、文件存储等
// 同一份(❌ 绕过它直接读表:那一行在 replica 里就会是旧的)。
// ❌ 不经 lib/chat.ts：那是 chatService 的地盘，而这份偏好与聊天无关（且该文件被 #2510 占）。

export async function readAgentCreateDefaults(): Promise<AgentCreateDefaults> {
  return parseAgentCreateDefaults(await readOwnSettings(await getCurrentAuthUserId(), 'user'))
}

/** Edit the agent_create key of the latest row (versioned write), keep the saved row, answer it parsed. */
async function remember(merge: (config: Record<string, unknown>) => Record<string, unknown>): Promise<AgentCreateDefaults> {
  const saved = await updateOwnSettingsKey(await getCurrentAuthUserId(), 'user', AGENT_CREATE_DEFAULTS_KEY,
    (value) => merge({ [AGENT_CREATE_DEFAULTS_KEY]: value })[AGENT_CREATE_DEFAULTS_KEY])
  return parseAgentCreateDefaults(saved.config)
}

export function rememberAgentCreateProject(deviceId: string, projectId: string | null, chatId?: string | null): Promise<AgentCreateDefaults> {
  return remember((config) => mergeAgentCreateProjectChoice(config, deviceId, projectId, chatId))
}

export function rememberAgentCreateRunMachine(projectKey: string, deviceId: string): Promise<AgentCreateDefaults> {
  return remember((config) => mergeAgentCreateRunMachine(config, projectKey, deviceId))
}
