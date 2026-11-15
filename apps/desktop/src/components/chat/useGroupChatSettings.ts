import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useRef, useState } from 'react'
import { replica, useReplica } from '../../lib/replica'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings, GroupCollabSnapshot, UpdateGroupChatSettingsInput } from '@gugu/core/shared/types/chat'
import { chatService } from '../../lib/chat'
import { rendererLogger } from '../../lib/log'

const settingsLog = rendererLogger('chat/group-settings')

type SettingsKey = keyof UpdateGroupChatSettingsInput & keyof GroupChatSettings

// What the server derives from a field: a write that owns the field takes these from the answer too (a line with its own
// threshold no longer follows the line above, so its effective threshold changes with it).
const DERIVED: Partial<Record<SettingsKey, readonly (keyof GroupChatSettings)[]>> = {
  agent_flood_threshold: ['agent_flood_threshold_effective'],
}

function pick(source: GroupChatSettings, keys: readonly SettingsKey[]): Partial<GroupChatSettings> {
  return Object.fromEntries(keys.flatMap((key) => [key, ...(DERIVED[key] ?? [])]).map((key) => [key, source[key]])) as Partial<GroupChatSettings>
}

/**
 * @@@6418 群设置的读与写。每一项改动**即时落库**(原来 9 项攒到底部「保存」一起写,关抽屉就丢)。
 *
 * - 读:一个群一份读数(groupSettings 读模型),聊天区、成员页、菜单、命令共用一次读;每次打开面板再读一次(不订阅
 *   chat_meta_changed,别的管理员改的靠这次读到)。没读到 = null(画占位),失败 fail-loud(#1125),❌ 显示默认值假装读到了。
 *   读和写交叠时这次读作废(它可能早于那次写):留着屏幕上那份,等写都回来再读一次。
 * - 写:先把改动乐观地写进本地,再 updateGroupChatSettings。
 *   几次写可能同时在路上(连拨几个开关),所以**每次写只认领自己那几个字段**:
 *   · 成功时只把服务端返回里「这次写的字段」并回本地 —— 晚到的响应不会把别的字段盖回旧值;
 *   · 失败时只把「这次写的字段」回滚到改之前 —— 不会顺带撤掉同时成功的另一项(或刚传好的头像)。
 *   同一字段被连写两次时,只有最后一次发出的那次有资格改它(per-field 序号)。
 */
/** Settings carry the viewer's authority: re-read them when a projected role changes, not on every roster refresh. */
export function groupRoleRevision(snapshot: GroupCollabSnapshot | null): string | undefined {
  if (!snapshot) return undefined
  return [...snapshot.humans, ...snapshot.agents].map((member) => `${member.id}:${member.role}`).sort().join(',')
}

// Writes in flight per chat, the per-field claim of the last write, and whether a read overlapped one (module level:
// every surface of a chat shares one reading, so they share its writes too).
const writes = new Map<string, { seq: number; inFlight: number; rereadAfter: boolean; latest: Map<SettingsKey, number> }>()
const writesOf = (chatId: string) => {
  let entry = writes.get(chatId)
  if (!entry) { entry = { seq: 0, inFlight: 0, rereadAfter: false, latest: new Map() }; writes.set(chatId, entry) }
  return entry
}

export const groupSettings = replica({
  name: 'groupSettings',
  scope: 'account',
  read: async (_owner: string, chatId: string): Promise<GroupChatSettings> => {
    const w = writesOf(chatId)
    const seqAtStart = w.seq
    const startedDuringWrite = w.inFlight > 0
    let loaded: GroupChatSettings
    try {
      loaded = await chatService.getGroupChatSettings(chatId)
    } catch (error) {
      settingsLog.error({ error, chatId }, 'group settings load failed')
      throw error
    }
    const shown = groupSettings.peek(chatId)
    if ((startedDuringWrite || w.seq !== seqAtStart) && shown.state === 'value') {
      if (w.inFlight > 0) w.rereadAfter = true
      else void groupSettings.refresh(chatId)
      return shown.value
    }
    return loaded
  },
})

/**
 * Write some of a group's settings, for every surface of the group: optimistic, then the server's answer for the fields
 * this write still owns; a failure rolls back only those fields and is thrown to the caller (who says it its own way).
 * Requires the settings to be read (there is no「before」to reconcile against otherwise).
 */
export async function writeGroupSettings(chatId: string, input: UpdateGroupChatSettingsInput): Promise<GroupChatSettings> {
  const shown = groupSettings.peek(chatId)
  if (shown.state !== 'value') throw new Error(`group settings of ${chatId} are not read yet`)
  const before = shown.value
  const w = writesOf(chatId)
  const keys = Object.keys(input) as SettingsKey[]
  const seq = ++w.seq
  for (const key of keys) w.latest.set(key, seq)
  const ownedKeys = () => keys.filter((key) => w.latest.get(key) === seq)
  groupSettings.set([chatId], (current) => (current ? { ...current, ...input } as GroupChatSettings : current))
  w.inFlight += 1
  try {
    const updated = await chatService.updateGroupChatSettings(chatId, input)
    groupSettings.set([chatId], (current) => (current ? { ...current, ...pick(updated, ownedKeys()) } : updated))
    return updated
  } catch (err) {
    groupSettings.set([chatId], (current) => (current ? { ...current, ...pick(before, ownedKeys()) } : current))
    settingsLog.error({ error: err, chatId, fields: keys }, 'group settings update failed')
    throw err
  } finally {
    w.inFlight -= 1
    if (w.inFlight === 0 && w.rereadAfter) {
      w.rereadAfter = false
      void groupSettings.refresh(chatId)
    }
  }
}

/** A row the pointer reaches: read its room's authority before its menu opens, once (❌ a read on every pass of the pointer). */
export function warmRowAuthority(chatId: string): void {
  if (groupSettings.peek(chatId).state === 'unknown') void groupSettings.prefetch(chatId)
}

export function useGroupChatSettings(chatId: string | null, revision?: string, authorityRevision = 0) {
  const { t } = useTranslation('messaging')
  const reading = useReplica(groupSettings, chatId ? [chatId] : null)
  const settings = reading.state === 'value' ? reading.value : null
  const readFailure = reading.state === 'error' ? reading.error : reading.state === 'value' ? reading.error : null
  // A write's failure belongs to the surface that wrote; a read's to every surface of the chat.
  const [writeError, setError] = useState<{ chatId: string | null; message: string } | null>(null)
  const error = writeError && writeError.chatId === chatId ? writeError.message
    : readFailure ? t('group.settings.loadFailed', { reason: String(readFailure.message ?? readFailure) }) : null

  // A role change re-reads in place (the first roster load is not a change); so does an authority revision.
  const seenRevision = useRef<{ chatId: string | null; revision?: string }>({ chatId })
  useEffect(() => {
    const seen = seenRevision.current
    if (seen.chatId !== chatId) seenRevision.current = { chatId, revision }
    else if (seen.revision && revision && seen.revision !== revision) { seen.revision = revision; if (chatId) void groupSettings.refresh(chatId) }
    else if (!seen.revision) seen.revision = revision
  }, [chatId, revision])
  const seenAuthority = useRef(authorityRevision)
  useEffect(() => {
    if (seenAuthority.current === authorityRevision) return
    seenAuthority.current = authorityRevision
    if (chatId) void groupSettings.refresh(chatId)
  }, [chatId, authorityRevision])

  const update = useCallback(async (input: UpdateGroupChatSettingsInput): Promise<boolean> => {
    if (!chatId || groupSettings.peek(chatId).state !== 'value') {
      // 设置还没读到(或读失败)时写,只会拿一个不存在的「之前」去对账 —— 明说,❌ 静默丢掉这次操作。
      setError({ chatId, message: t('group.settings.notLoaded') })
      return false
    }
    setError(null)
    try {
      await writeGroupSettings(chatId, input)
      return true
    } catch (err) {
      setError({ chatId, message: messageForUser(err) })
      return false
    }
  }, [chatId, t])

  const setAvatarUrl = useCallback((avatarUrl: string | null) => {
    if (!chatId) return
    writesOf(chatId).seq += 1
    groupSettings.set([chatId], (current) => (current ? { ...current, avatar_url: avatarUrl } : current))
  }, [chatId])

  const reload = useCallback(() => { if (chatId) void groupSettings.refresh(chatId) }, [chatId])
  const setMessage = useCallback((message: string | null) => { setError(message === null ? null : { chatId, message }) }, [chatId])

  return { settings, error, setError: setMessage, update, setAvatarUrl, reload }
}

export type GroupChatSettingsState = ReturnType<typeof useGroupChatSettings>
