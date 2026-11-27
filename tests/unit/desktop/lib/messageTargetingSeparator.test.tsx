// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { MessageMetaRow } from '../../../../apps/desktop/src/components/chat/MessageMetaRow'

// The badge under a message that names whom it was sent to: its names are joined in the reader's language.
describe('message targeting badge separator', () => {
  const badge = () => renderToStaticMarkup(
    <MessageMetaRow targetingLabels={['Ann', 'Codex 1']} forwardedFromMessageId={null} viaApp={null} viaAppSender={null} />,
  )

  it('joins names with ", " in English and 「、」 in Chinese', () => {
    setLocalePreference('en-US')
    expect(badge()).toContain('→ Ann, Codex 1')
    setLocalePreference('zh-CN')
    expect(badge()).toContain('→ Ann、Codex 1')
  })
})
