import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { assistantHomePaths, type AssistantHomeKind } from '@gugu/core/shared/assistantPolicy'

/** How a connected application is used: by a delegated task, with the skills it should load. */
export type AssistantIntegrationUse = { note: string; delegate: { tool: string }; task_skills: string[] }

export type AssistantLocalSource = {
  source: 'assistant_memory' | 'assistant_personality' | 'assistant_files' | 'integrations' | 'chat_channels'
  status: 'read' | 'unavailable'
  items?: Array<{ id: string; name: string; path?: string; modifiedAt: string; size?: number; isDefault?: boolean; use?: AssistantIntegrationUse; note?: string }>
  read: string
}

/** Metadata only: these rows never carry memory, personality or credential bodies. */
export async function assistantLocalIndex(
  cwd: string, kind: AssistantHomeKind, home = homedir(),
  integrations: () => Promise<NonNullable<AssistantLocalSource['items']>> = async () => { throw new Error('Integration metadata source is unavailable') },
  chatChannels: () => Promise<NonNullable<AssistantLocalSource['items']>> = async () => { throw new Error('Chat channel metadata source is unavailable') },
): Promise<AssistantLocalSource[]> {
  const paths = assistantHomePaths(home, cwd, kind)
  async function source(
    name: AssistantLocalSource['source'], read: string,
    collect: () => Promise<NonNullable<AssistantLocalSource['items']>>,
  ): Promise<AssistantLocalSource> {
    try { return { source: name, read, status: 'read', items: await collect() } }
    catch { return { source: name, read, status: 'unavailable' } }
  }
  async function file(path: string, name: string) {
    const info = await stat(path)
    return { id: path, name, path, modifiedAt: info.mtime.toISOString(), size: info.size }
  }
  async function directory(path: string, markdown: boolean) {
    const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    return Promise.all(entries.filter(entry => !entry.name.startsWith('.') && (!markdown || entry.isFile() && /\.md$/i.test(entry.name)))
      .sort((a, b) => a.name.localeCompare(b.name)).map(entry => file(join(path, entry.name), entry.name)))
  }
  return Promise.all([
    source('assistant_memory', `Read/Glob: ${paths.memoryDir}`, () => directory(paths.memoryDir, true)),
    source('assistant_personality', `Read: ${paths.instructions}; 用户保存说明或性格后，按需重读并应用其当前约定。`, async () => {
      try { return [await file(paths.instructions, 'assistant instructions')] }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    }),
    source('assistant_files', `Read/Glob: ${paths.resourcesDir}; 此处只索引顶层条目，子目录按需读取。`, () => directory(paths.resourcesDir, false)),
    source('integrations', '已保存的集成账号配置；带 use 的按 use 派任务，带 note 的照 note，其余经 catalog_list。不等于已通过实时连通或授权验证，使用前按相应工具核实。', integrations),
    source('chat_channels', '已接入的聊天渠道；通过 gugu://assistant/resources 重读。与普通工具/集成目录分开：没有独立微信工具不代表未连接微信。health 与绑定是当前配置摘要，不保证消息已送达；咕咕私聊消息由渠道服务按现有策略转发，近期对话渠道和默认渠道会影响去向，不能承诺每次定时结果都转发；此处不授予额外发送能力。', chatChannels),
  ])
}
