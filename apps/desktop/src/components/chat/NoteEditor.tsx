import type { ComponentProps } from 'react'
import { MessageProvider, PromptEditor, type ContextMentionProvider, type MentionItem } from '@gugu/session-ui/react/components'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { useLocale } from '@/i18n'
import { useTheme } from '../../store/theme'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'

/**
 * A few words with @, outside a composer: the composer's own editor and @ (`PromptEditor`), over the one mention list the
 * caller has — a chat's members, a session's. A forward's note and a selection's Send both write in it.
 */
export function NoteEditor({ mentionProvider, renderMentionIcon, onChange, onMentionInsert, onSubmit, inputRef, placeholder, inputTestId, enterBehavior = 'newline', disabled }: {
  mentionProvider?: ContextMentionProvider
  renderMentionIcon?: ComponentProps<typeof PromptEditor>['renderMentionIcon']
  onChange: (text: string) => void
  onMentionInsert?: (item: MentionItem) => void
  onSubmit?: (text: string) => void
  inputRef?: (element: HTMLElement | null) => void
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
        <PromptEditor inputTestId={inputTestId} inputRef={inputRef} enterBehavior={enterBehavior} placeholder={placeholder} disabled={disabled}
          onChange={onChange} onSubmit={onSubmit} clearOnSubmit={false} onMentionInsert={onMentionInsert} mentionProvider={mentionProvider} renderMentionIcon={renderMentionIcon} />
      </MessageProvider>
    </SessionUiTheme>
  )
}
