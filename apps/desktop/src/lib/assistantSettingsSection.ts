/**
 * Which part of the assistant's settings page (资料, drawn over its App's panel) an entry asked for: today only its model
 * (`aimodel`) — the failure bar's 换模型 and the App's `gugu.assistant.open(name, "model")`. The personal assistant's agent
 * dialog is its figure alone (owner 11-12), so the model lives on that page. One-shot: the page takes it once.
 */
export type AssistantSettingsSection = 'aimodel'

let pending: AssistantSettingsSection | null = null
const listeners = new Set<() => void>()

export function requestAssistantSettingsSection(section: AssistantSettingsSection | null): void {
  pending = section
  for (const listener of [...listeners]) listener()
}

export function takeAssistantSettingsSection(): AssistantSettingsSection | null {
  const section = pending
  pending = null
  return section
}

export function onAssistantSettingsSection(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
