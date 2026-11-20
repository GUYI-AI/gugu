import type { ComponentProps, Ref } from 'react'
import { MessageProvider, PromptEditor, type ContextMentionProvider, type MentionItem, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { useLocale } from '@/i18n'
import { useTheme } from '../../store/theme'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'

/**
 * A few words with @, outside a composer: the composer's own editor and @ (`PromptEditor`), over the one mention list the
 * caller has — a chat's members, a session's. A forward's note, a selection's Send and an App's Hand to all write in it.
 */
export function NoteEditor({ mentionProvider, renderMentionIcon, onChange, onMentionInsert, onSubmit, inputRef, editorRef, placeholder, inputTestId, enterBehavior = 'newline', disabled }: {
  mentionProvider?: ContextMentionProvider
  renderMentionIcon?: ComponentProps<typeof PromptEditor>['renderMentionIcon']
  onChange: (text: string) => void
  onMentionInsert?: (item: MentionItem) => void
  onSubmit?: (text: string) => void
  inputRef?: (element: HTMLElement | null) => void
  /** The editor itself: to start it with words already written (`setText`). */
  editorRef?: Ref<PromptEditorRef>
  placeholder: string
  inputTestId: string
  enterBehavior?: 'submit' | 'newline'
  disabled?: boolean
}) {
  const { theme } = useTheme()
  const { resolvedLocale } = useLocale()
  return (
    <SessionUiTheme theme={theme} skin>
      <MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
        <PromptEditor ref={editorRef} inputTestId={inputTestId} inputRef={inputRef} enterBehavior={enterBehavior} placeholder={placeholder} disabled={disabled}
          onChange={onChange} onSubmit={onSubmit} clearOnSubmit={false} onMentionInsert={onMentionInsert} mentionProvider={mentionProvider} renderMentionIcon={renderMentionIcon} />
      </MessageProvider>
    </SessionUiTheme>
  )
}
