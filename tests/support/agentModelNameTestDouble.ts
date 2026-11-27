// Test double for `apps/desktop/src/hooks/useAgentModelName`: a row's model as presence would carry it, set per test.
const models: Record<string, string> = {}

export function setAgentModelNameOverride(agentUserId: string, modelName: string): void {
  models[agentUserId] = modelName
}

export function clearAgentModelNameOverrides(): void {
  for (const id of Object.keys(models)) delete models[id]
}

export function useAgentModelName(agentUserId: string | undefined): string | null {
  return agentUserId ? models[agentUserId] ?? null : null
}

export function useAgentModelNames(agentUserIds: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(agentUserIds.filter((id) => id in models).map((id) => [id, models[id]!]))
}
