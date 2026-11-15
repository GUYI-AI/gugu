import type { ReactNode } from 'react'
import type { AssistantMachine, MemoryEntry } from '@/session/renderer/features/assistant/assistant-machine-core'
import { useAssistantMemoryBody } from './assistant-panel-reads'

/** A failed preview belongs to its card; the metadata list remains readable. The text is read once per revision. */
export function AssistantMemoryContent({ machine,entry,children }: {
  machine: AssistantMachine | undefined; entry: MemoryEntry;
  children: (entry: MemoryEntry,error: unknown,loading: boolean) => ReactNode;
}) {
  const body = useAssistantMemoryBody(machine,entry)
  if (!entry.contentPending) return children(entry,null,false)
  // Until its text is read the card draws the note's title and kind (from the list) with the loading state.
  if (body.state === 'unknown') return children(entry,null,true)
  if (body.state === 'error') return children(entry,body.error,false)
  return children(body.value,body.error,false)
}
