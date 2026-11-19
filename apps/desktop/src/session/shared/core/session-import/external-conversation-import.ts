export type ExternalImportSource = 'chatgpt' | 'cursor'

export interface ExternalMessage {
  role: 'user' | 'assistant'
  text: string
  at: number | null
}

export interface ExternalConversation {
  sourceId: string
  title: string
  messages: ExternalMessage[]
}

export interface ExternalImportHistoryEntry {
  title: string
  projectId: null
  sessionId: string
  importedAt: number
}

export interface ExternalImportScan {
  count: number
  pending: boolean
  needsSource?: true
}

export interface ExternalImportPage {
  title: string
  messages: ExternalMessage[]
  nextOffset: number | null
}

export interface ExternalImportBatch {
  imported: ExternalImportHistoryEntry[]
  alreadyImported: number
  failed: number
  done: number
  total: number
}

export const externalImportChannels = {
  scan: 'external-history:scan',
  pick: 'external-history:pick',
  start: 'external-history:start',
  next: 'external-history:next',
  cancel: 'external-history:cancel',
  list: 'external-history:list',
  read: 'external-history:read',
} as const
