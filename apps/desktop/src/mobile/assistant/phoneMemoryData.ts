// #7199 手机「记忆」下手机自己那一页(健康页点开的那一条记忆)删一条记忆:动词是 assistant-machine-core 那一组(与桌面同一份核心),
// 这里只把桌面页面里那一步拆成不带界面的函数,手机页与单测共用。
import { removeIndexEntry } from '@/session/renderer/features/assistant/assistant-files'
import { readText, removePath, writeText, type AssistantMachine, type MemoryEntry } from '@/session/renderer/features/assistant/assistant-machine-core'

/** 删一条记忆:文件 + MEMORY.md 里指向它的那一行(与桌面 MemoryNoteDetail 同一套;索引是它每次开工读的目录)。 */
export async function deleteMemoryNote(machine: AssistantMachine, entry: Pick<MemoryEntry, 'path' | 'file'>, onRemoved?: () => Promise<void>): Promise<void> {
  await removePath(machine, entry.path)
  await onRemoved?.()
  if (machine.panel) return
  const index = await readText(machine, machine.paths.memoryIndex)
  if (index === null) return
  const next = removeIndexEntry(index, entry.file)
  if (next !== index) await writeText(machine, machine.paths.memoryIndex, next)
}
