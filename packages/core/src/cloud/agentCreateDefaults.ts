import {
  AGENT_CREATE_DEFAULTS_KEY,
  mergeAgentCreateDeviceChoice,
  mergeAgentCreateProjectChoice,
  parseAgentCreateDefaults,
  type AgentCreateDefaults
} from '../shared/ui/agentCreateDefaultsModels'
import {
  readUserSettingsConfig,
  updateUserSettingsKey,
  type SettingsTableClient
} from './userSettings'

// @@@per-user-create-defaults (#2525) — 共享 Session Composer 的设备/项目默认值，per-user 持久化。
// 载体是既有的 identity.user_settings（scope='user'，config.agent_create）：PK (user_id, scope)、
// RLS user_settings_own、GRANT ALL TO authenticated 都已就位 → 本功能**零迁移**。
// Only edit this preference on the latest row version: other account settings share the same scope.

const USER_SCOPE = 'user' as const

export async function readAgentCreateDefaults(
  client: SettingsTableClient,
  userId: string
): Promise<AgentCreateDefaults> {
  return parseAgentCreateDefaults(await readUserSettingsConfig(client, userId, USER_SCOPE))
}

export async function rememberAgentCreateDevice(
  client: SettingsTableClient,
  userId: string,
  deviceId: string
): Promise<AgentCreateDefaults> {
  const saved = await updateUserSettingsKey(client, userId, USER_SCOPE, AGENT_CREATE_DEFAULTS_KEY,
    (value) => mergeAgentCreateDeviceChoice({ [AGENT_CREATE_DEFAULTS_KEY]: value }, deviceId)[AGENT_CREATE_DEFAULTS_KEY])
  return parseAgentCreateDefaults(saved.config)
}

export async function rememberAgentCreateProject(
  client: SettingsTableClient,
  userId: string,
  deviceId: string,
  projectId: string | null,
  chatId?: string | null
): Promise<AgentCreateDefaults> {
  const saved = await updateUserSettingsKey(client, userId, USER_SCOPE, AGENT_CREATE_DEFAULTS_KEY,
    (value) => mergeAgentCreateProjectChoice({ [AGENT_CREATE_DEFAULTS_KEY]: value }, deviceId, projectId, chatId)[AGENT_CREATE_DEFAULTS_KEY])
  return parseAgentCreateDefaults(saved.config)
}
