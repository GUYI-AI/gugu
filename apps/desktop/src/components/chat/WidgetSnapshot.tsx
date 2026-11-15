import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow } from '../../lib/icons'
import { useAuth } from '../../store/auth'
import { useTheme } from '../../store/theme'
import { useReplica } from '../../lib/replica'
import { widgetWidthBucket } from '../../lib/widgetSnapshots'
import { widgetSnapshot } from '../../lib/widgetSnapshot'

export function WidgetLoading({ text, loading = true }: { text: string; loading?: boolean }) {
  const { t } = useTranslation('messaging')
  return <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-secondary)] p-3 text-[var(--text-secondary)]" data-widget-loading>
    <AppWindow aria-hidden="true" size={24} />
    <span>{text}</span>
    {loading ? <span className="text-[length:var(--font-caption)]">{t('message.reference.loading')}</span> : null}
  </div>
}

export function WidgetSnapshot({ widgetId, visible, text, inactive = false }: { widgetId: string; visible: boolean; text: string; inactive?: boolean }) {
  const { user } = useAuth()
  const { theme } = useTheme()
  const own = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  // Its own box fills the slot: measured before the first paint, so a slot mounted again (back in a conversation) reads its
  // width's picture from the replica in that frame, ❌ the loading face first.
  useLayoutEffect(() => {
    if (!own.current) return
    const update = () => setWidth(own.current?.clientWidth ?? 0)
    const observer = new ResizeObserver(update)
    observer.observe(own.current)
    update()
    return () => observer.disconnect()
  }, [visible])
  const reading = useReplica(widgetSnapshot, user?.id && width > 0 ? [widgetId, theme, widgetWidthBucket(width)] : null)
  if (!visible) return null
  // Not read yet, none kept, or unreadable (a picture is a stand-in, never the widget itself): the widget's loading face.
  const url = reading.state === 'value' ? reading.value : null
  return <div ref={own} className="pointer-events-none absolute inset-0">
    {url ? <img src={url} alt="" aria-hidden="true" className={`pointer-events-none absolute inset-0 h-full w-full object-fill ${inactive ? 'grayscale opacity-50' : ''}`} data-widget-snapshot />
      : <WidgetLoading text={text} loading={!inactive} />}
  </div>
}
