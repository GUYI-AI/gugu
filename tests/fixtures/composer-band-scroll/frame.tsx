import { useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { composerSlotClass, composerSlotInnerClass } from '@gugu/session-chat-ui/composer-layout'
import { ThreadScrollToBottom } from '@renderer/lib/ui/assistant-ui/thread-scroll-to-bottom'
import { nativeChatAppearance } from '@renderer/lib/chat/native-chat-appearance.css'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { i18n } from '@/i18n'
import { sessionComposerFrameLiftClassName, sessionComposerTrayClassName, sessionComposerTrayStyle, sessionComposerTrayTriggerClassName } from '@renderer/features/sessions/session-composer-styles'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

export function ScheduledBand() {
  return <div data-composer-band data-composer-top-band="schedule" className={sessionComposerTrayClassName} style={sessionComposerTrayStyle}>
    <span className={sessionComposerTrayTriggerClassName}>Controlled fixture · scheduled items</span>
  </div>
}

export type FrameOptions = {
  theme?: 'light' | 'dark'
  band?: ReactNode
  scheduled?: boolean
  phone?: boolean
  atBottom?: boolean
  composerProps?: Partial<ComponentProps<typeof ChatComposer>>
  onScrollToBottom?: () => void
}

/** Two independent portals into the real composer column, in the task page's paint order. No task identity or service. */
export function Frame({ theme = 'light', band, scheduled, phone, atBottom = false, composerProps, onScrollToBottom = () => {} }: FrameOptions) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const translate = i18n.getFixedT('en-US', 'session')
  return <ThemeProvider theme={theme}><SessionLocalizationProvider>
    <MessageProvider locale="en-US" translate={(key, values) => translate(key, { ...values, interpolation: { prefix: '{', suffix: '}' } })}>
      <div className={nativeChatAppearance} data-phone-shell={phone ? '' : undefined}
        style={{ position: 'relative', height: 480, '--chat-bg': 'var(--bg)' } as CSSProperties}>
        <div data-chat-root="">
          <div data-chat-composer-placement="bottom" className={composerSlotClass} style={{ position: 'absolute', bottom: 0 }}>
            <div ref={setSlot} className={composerSlotInnerClass} />
          </div>
        </div>
        {slot ? createPortal(<ThreadScrollToBottom atBottom={atBottom} label="Return to bottom" onScrollToBottom={onScrollToBottom} />, slot, 'recovery') : null}
        {slot ? createPortal(<>{band}<ChatComposer onSubmit={() => {}} mobile={phone} className={scheduled ? sessionComposerFrameLiftClassName : undefined} {...composerProps} /></>, slot, 'composer') : null}
      </div>
    </MessageProvider>
  </SessionLocalizationProvider></ThemeProvider>
}
