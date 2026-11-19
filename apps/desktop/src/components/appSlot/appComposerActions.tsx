import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ComposerAttachAction } from '../chat/ComposerAttachButton'
import { useVoiceNoteHandler } from '../assistant/useVoiceNoteHandler'
import { ArrowUpToLine, BookOpen, FileText, Heart, Image, Lightbulb, ListChecks, MessageSquare, Mic, Pencil, Sparkles } from '../../lib/icons'
import { rendererLogger } from '../../lib/log'
import { useChatStore } from '../../store/chatContext'
import { events, rpc } from '@/session/renderer/lib/ipc'
import type { ComposerActionIcon, ComposerActionView } from '@/session/shared/extensions/composer-actions'
import { extensionsInventoryChangedChannel } from '@/session/shared/extensions/marketEvents'

const log = rendererLogger('app-composer-actions')
// One empty list, so a menu not yet read (or read for another App) keeps one identity across renders.
const NO_VIEWS: ComposerActionView[] = []

/** The host's icons an App's entry may name (composer-actions.ts), the same glyphs as the built-in entries. */
const ICONS: Record<ComposerActionIcon, ReactNode> = {
  sparkles: <Sparkles />, mic: <Mic />, upload: <ArrowUpToLine />, lightbulb: <Lightbulb />, pencil: <Pencil />, heart: <Heart />,
  checklist: <ListChecks />, document: <FileText />, book: <BookOpen />, image: <Image />, message: <MessageSquare />,
}

/** The entries as the 「+」 menu draws them: the App's words in the person's language, the voice note greyed while recording. */
export function composerMenu(
  views: readonly ComposerActionView[],
  { zh, recording, run }: { zh: boolean; recording: boolean; run: (id: string) => void },
): ComposerAttachAction[] | undefined {
  if (views.length === 0) return undefined
  return views.map((view) => ({
    id: `app-${view.id}`,
    label: zh ? view.label.zh : view.label.en,
    icon: ICONS[view.icon],
    disabled: view.kind === 'voice-note' && recording,
    onSelect: () => run(view.id),
  }))
}

/** The entry an App marks `chip`, as the capsule above the composer draws it: its shorter label, the entry's icon. */
export type ComposerChip = { id: string; label: string; icon: ReactNode; onSelect: () => void }
export function composerChip(views: readonly ComposerActionView[], { zh, run }: { zh: boolean; run: (id: string) => void }): ComposerChip | null {
  const view = views.find((entry) => entry.chip)
  if (!view?.chip) return null
  return { id: `app-${view.id}`, label: zh ? view.chip.zh : view.chip.en, icon: ICONS[view.icon], onSelect: () => run(view.id) }
}

type Column = { ownerId: string; extensionId: string; authority: string; chatId: string }

/**
 * #1927 (API 48) The 「+」 entries an App placed beside the person's own assistant chat declares, for this column
 * (AppConversationSurfaceHost): main says which to draw — none unless this is that chat — and runs the one the person
 * clicks (app-composer-actions.ts). Only ids go to main; no App code runs on the click. A draft comes back for this
 * composer, in the person's language, put after what they already wrote, as the built-in's 「分析健康报告」 does
 * (AssistantChatSlot).
 */
export function useAppComposerActions(column: Column) {
  return useAppComposerEntries(column).menu
}

/** The same entries, and the one also drawn as the capsule above the composer (`chip`), run the same way. */
export function useAppComposerEntries({ ownerId, extensionId, authority, chatId }: Column) {
  const { i18n } = useTranslation()
  const { writeDraft } = useChatStore('writeDraft')
  const { recording } = useVoiceNoteHandler()
  const asked = `${ownerId}\n${extensionId}\n${authority}`
  const [read, setRead] = useState<{ asked: string; views: ComposerActionView[] } | null>(null)
  const [serial, setSerial] = useState(0)
  // The language when the draft lands, not when the menu was drawn.
  const zhNow = useCallback(() => i18n.language.startsWith('zh'), [i18n])
  // A grant of this App changed (its draft or recorder withdrawn, say): read again.
  useEffect(() => events.on(extensionsInventoryChangedChannel, (note) => {
    if (!note?.extensionId || note.extensionId === extensionId) setSerial((value) => value + 1)
  }), [extensionId])
  useEffect(() => {
    let disposed = false
    void rpc.extensions.conversationComposerActions({ ownerId, extensionId, authority }).then((result) => {
      if (disposed) return
      if (!result.success) throw new Error(result.error)
      setRead({ asked, views: result.data.actions })
    }).catch((error: unknown) => {
      // What could not be read is not drawn.
      if (disposed) return
      log.warn({ error }, 'Could not read the App\'s composer actions')
      setRead({ asked, views: [] })
    })
    return () => { disposed = true }
  }, [ownerId, extensionId, authority, asked, serial])
  const run = useCallback((actionId: string) => {
    void rpc.extensions.runConversationComposerAction({ ownerId, extensionId, authority, actionId }).then((result) => {
      if (!result.success) {
        // Refused (the App switched off, its grant gone, another account) or not to be made now: nothing happens.
        log.warn({ error: result.error, code: result.code }, 'App composer action not run')
        return
      }
      if (result.data.kind === 'draft') writeDraft(chatId, { at: 'end', text: zhNow() ? result.data.text.zh : result.data.text.en })
    }, (error: unknown) => log.warn({ error }, 'App composer action failed'))
  }, [ownerId, extensionId, authority, chatId, writeDraft, zhNow])
  const views = read?.asked === asked ? read.views : NO_VIEWS
  const zh = i18n.language.startsWith('zh')
  const menu = useMemo(() => composerMenu(views, { zh, recording, run }), [views, zh, recording, run])
  const chip = useMemo(() => composerChip(views, { zh, run }), [views, zh, run])
  return { menu, chip }
}
