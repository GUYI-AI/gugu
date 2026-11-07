import { useEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow } from '../../lib/icons'
import { useAuth } from '../../store/auth'
import { useTheme } from '../../store/theme'
import { rendererLogger } from '../../lib/log'
import { widgetSnapshotKey, widgetSnapshots, WIDGET_SNAPSHOT_EVENT } from '../../lib/widgetSnapshots'

const log = rendererLogger('chat/widget-snapshot')
// The last picture read this session per account, widget and theme: a slot mounted again (back in a conversation) paints
// it in its first frame, before its width is measured and IndexedDB answers. The account is in the key, so another
// account never meets them. Data URLs, not object URLs: slots of one widget share an entry, and nothing has to be revoked
// while another slot still shows it.
const decoded = new Map<string, string>()
function remember(key: string, url: string) {
  decoded.delete(key)
  decoded.set(key, url)
  if (decoded.size > 64) decoded.delete(decoded.keys().next().value!)
}
const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result as string)
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(blob)
})

export function WidgetLoading({ text, loading = true }: { text: string; loading?: boolean }) {
  const { t } = useTranslation('messaging')
  return <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-secondary)] p-3 text-[var(--text-secondary)]" data-widget-loading>
    <AppWindow aria-hidden="true" size={24} />
    <span>{text}</span>
    {loading ? <span className="text-[length:var(--font-caption)]">{t('message.reference.loading')}</span> : null}
  </div>
}

export function WidgetSnapshot({ widgetId, element, visible, text, inactive = false }: { widgetId: string; element: RefObject<HTMLDivElement | null>; visible: boolean; text: string; inactive?: boolean }) {
  const { user } = useAuth()
  const accountId = user?.id
  const { theme } = useTheme()
  const [width, setWidth] = useState(0)
  const [picture, setPicture] = useState<{ key: string; url: string } | null>(null)
  const key = widgetSnapshotKey(accountId ?? '', widgetId, theme, width)
  const remembered = `${accountId ?? ''}\n${widgetId}\n${theme}`
  useEffect(() => {
    if (!element.current) return
    const update = () => setWidth(element.current?.clientWidth ?? 0)
    const observer = new ResizeObserver(update)
    observer.observe(element.current)
    update()
    return () => observer.disconnect()
  }, [element])
  useEffect(() => {
    if (!accountId || width <= 0) return
    let live = true, revision = 0
    const read = () => {
      const asked = ++revision
      void widgetSnapshots.read(widgetId, theme, width).then(blob => blob && dataUrl(blob)).then(url => {
        if (!live || asked !== revision || !url) return
        remember(remembered, url)
        setPicture({ key, url })
      }, error => log.warn({ error: String(error) }, 'Widget snapshot could not be read'))
    }
    read()
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === key) read() }
    window.addEventListener(WIDGET_SNAPSHOT_EVENT, changed)
    return () => { live = false; window.removeEventListener(WIDGET_SNAPSHOT_EVENT, changed) }
  }, [key, remembered, accountId, widgetId, theme, width])
  if (!visible) return null
  const url = picture?.key === key ? picture.url : decoded.get(remembered)
  if (url) return <img src={url} alt="" aria-hidden="true" className={`pointer-events-none absolute inset-0 h-full w-full object-fill ${inactive ? 'grayscale opacity-50' : ''}`} data-widget-snapshot />
  return <WidgetLoading text={text} loading={!inactive} />
}
