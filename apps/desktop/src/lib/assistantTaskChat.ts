import { useSyncExternalStore } from 'react'

export type TaskChatEndpoint = { deviceId: string; sessionId: string }
export type AssistantTaskChat = {
  workId: string
  title?: string
  outcome?: 'active' | 'completed' | 'failed' | 'cancelled'
  assistantId: string
  taskAgentId: string | null
  task: TaskChatEndpoint
  assistants: TaskChatEndpoint[]
}
export const OPEN_ASSISTANT_TASK_CHAT = '__open_assistant_task_chat'
type Registry = { entries: Map<string, AssistantTaskChat>; listeners: Set<() => void>; loaded?: Set<string>; opened?: OpenedAssistantTaskChat | null }
export type OpenedAssistantTaskChat = { ownerId: string; request: AssistantTaskChat; name: string }
const KEY = '__GUGU_ASSISTANT_TASK_CHATS__'
const taskKey = (ownerId: string,task: AssistantTaskChat) => `${ownerId}:${task.taskAgentId??task.task.sessionId}:${task.workId}`
function registry(): Registry {
  const target = window as unknown as Record<string, unknown>
  return (target[KEY] ??= { entries: new Map(), listeners: new Set() }) as Registry
}
export function rememberAssistantTaskChat(ownerId: string, task: AssistantTaskChat): void {
  loadOwner(ownerId)
  registry().entries.set(taskKey(ownerId,task), task)
  try {
    localStorage.setItem(`gugu:assistant-task-chats:v1:${ownerId}`, JSON.stringify([...registry().entries].filter(([key]) => key.startsWith(`${ownerId}:`)).map(([, value]) => value)))
  } catch { /* The in-memory address remains usable when browser storage is unavailable. */ }
  for (const listener of registry().listeners) listener()
}
export function readAssistantTaskChat(ownerId: string | undefined, agentId: string | null | undefined): AssistantTaskChat | null {
  if (ownerId) loadOwner(ownerId)
  if (!ownerId || !agentId) return null
  const opened = registry().opened
  if (opened?.ownerId === ownerId && opened.request.taskAgentId === agentId) return opened.request
  const matches=[...registry().entries].filter(([key,task])=>key.startsWith(`${ownerId}:`)&&task.taskAgentId===agentId)
  return matches.length===1?matches[0]![1]:null
}
function loadOwner(ownerId: string): void {
  const data = registry()
  const loaded = data.loaded ??= new Set()
  if (loaded.has(ownerId)) return
  loaded.add(ownerId)
  const endpoint = (value: unknown): value is TaskChatEndpoint => !!value && typeof value === 'object'
    && typeof (value as TaskChatEndpoint).deviceId === 'string' && typeof (value as TaskChatEndpoint).sessionId === 'string'
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`gugu:assistant-task-chats:v1:${ownerId}`) ?? '[]')
    if (!Array.isArray(saved)) return
    for (const task of saved as AssistantTaskChat[]) {
      // An address saved without its work (written by older builds) names no work to open: it is not read.
      if (!task || typeof task.workId !== 'string' || typeof task.assistantId !== 'string' || typeof task.taskAgentId !== 'string' || !endpoint(task.task)
        || !Array.isArray(task.assistants) || !task.assistants.every(endpoint)) continue
      data.entries.set(taskKey(ownerId,task), task)
    }
  } catch { /* Ignore an unreadable saved address; selecting the task records its current address again. */ }
}
export function subscribeAssistantTaskChats(listener: () => void): () => void {
  registry().listeners.add(listener)
  return () => { registry().listeners.delete(listener) }
}

const openedTaskChat = (): OpenedAssistantTaskChat | null => registry().opened ?? null
export function showAssistantTaskChat(opened: OpenedAssistantTaskChat | null): void {
  registry().opened = opened
  for (const listener of registry().listeners) listener()
}
export function useOpenedAssistantTaskChat(): OpenedAssistantTaskChat | null {
  return useSyncExternalStore(subscribeAssistantTaskChats, openedTaskChat)
}

