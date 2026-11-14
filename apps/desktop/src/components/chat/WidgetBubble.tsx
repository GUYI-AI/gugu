import { observer } from 'mobx-react-lite'
import { useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { parseWidgetMessage, type WidgetMessage } from '@gugu/core/shared/ui/widgetModels'
import { platform } from '../../platform'
import { appsHere } from '../appSlot/appsHere'
import { PhoneAppFrame } from '../appSlot/PhoneAppFrame'
import { Button } from '../ui/Button'
import { APP_OPEN_WITH_EVENT } from '../../session/shared/extensions/app-runtime-protocol'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { isInstallRefused } from '../../session/shared/extensions/attachment-install'
import { refusedLine } from '../extensionBundle/installedHere'
import { extensionViewStore, residentPageKey, residentPlace } from '../../session/renderer/features/extensions/extension-view-store'
import { WidgetLoading, WidgetSnapshot } from './WidgetSnapshot'
import { useWidgetOriginal } from './useMessageReference'
import { useWidgetPresence } from './useWidgetPresence'
import type { ResolvedWidget } from '../../lib/widgetRegistry'
import { useConversationVisibility } from './useConversationVisibility'
import { useStayedInView } from './useStayedInView'
import { SentMessageSurface, widgetTabId } from './sentMessageSurface'
import { useAuth } from '../../store/auth'
import { messageForUser } from '../../lib/userFacingError'
import { rendererLogger } from '../../lib/log'
import { installPackageOf, sharedPackagesOf, subscribeSharedPackages, type SharedPackage } from '../extensionBundle/sharedPackages'
import { availableInstallOffers, widgetInstallOffer, type MarketOffer } from '../extensionBundle/installOffers'

const log = rendererLogger('chat/widget')

type Message = Pick<MessageItem, 'id' | 'chat_id' | 'sender_user_id' | 'content'>

export const WidgetBubble = observer(function WidgetBubble({ message, slotMessageId = message.id, referenceWidget }: { message: Message; slotMessageId?: string; referenceWidget?: ResolvedWidget }) {
  const { t } = useTranslation('messaging')
  const widget = useMemo(() => referenceWidget?.widget ?? parseWidgetMessage(message.content), [message.content, referenceWidget])
  if (!widget) return <span>{t('message.widget')}</span>
  if (!installedExtensionsStore.isLoaded) return <p>{widget.text}</p>
  const manifest = installedExtensionsStore.manifestFor(widget.app)
  const tab = manifest?.contributes.tabs.find(tab => tab.name === widget.view)
  const reason = !appsHere || (manifest?.platforms && !manifest.platforms.includes(platform.kind === 'electron' ? 'desktop' : 'phone')) ? 'platform'
    : !manifest ? 'missing' : !installedExtensionsStore.isEnabled(widget.app) ? 'disabled' : !tab?.widget ? 'view' : null
  if (reason || !tab?.widget) return <WidgetUnavailable widget={widget} reason={reason ?? 'view'} chatId={message.chat_id} />
  return referenceWidget ? <WidgetView key={`${referenceWidget.id}:${manifest?.version}`} message={message} slotMessageId={slotMessageId} resolved={referenceWidget} height={widget.height ?? tab.widget.height} />
    : <OriginalWidgetView message={message} slotMessageId={slotMessageId} height={widget.height ?? tab.widget.height} text={widget.text} />
})

function OriginalWidgetView({ message, slotMessageId, height, text }: { message: Message; slotMessageId: string; height: number; text: string }) {
  const resolved = useWidgetOriginal(message)
  // An original the registry does not know (never registered, or not readable here) is its text only.
  if (resolved instanceof Error || !resolved) return <div className="w-[420px] max-w-full min-w-0" data-widget-bubble={slotMessageId}>
    <WidgetFrame height={height}>
      {resolved instanceof Error ? <div role="alert">{messageForUser(resolved)}</div> : <WidgetLoading text={text} loading={resolved === undefined} />}
    </WidgetFrame>
  </div>
  return <WidgetView message={message} slotMessageId={slotMessageId} resolved={resolved} height={height} />
}

function WidgetFrame({ height, children, element }: { height: number; children: ReactNode; element?: RefObject<HTMLDivElement | null> }) {
  return <div ref={element} className="relative flex w-full min-w-0 overflow-hidden rounded-md" style={{ height }}>{children}</div>
}

const WidgetView = observer(function WidgetView({ message, slotMessageId, resolved, height }: { message: Message; slotMessageId: string; resolved: ResolvedWidget; height: number }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { widget, id: widgetId, senderId } = resolved
  const phone = platform.kind !== 'electron'
  const { ref, shown } = useConversationVisibility(true)
  const inTimeline = useContext(SentMessageSurface)
  // A widget's page is a process of its own, and mounting it holds a scroll frame: in a timeline it starts once the row stays.
  const stayed = useStayedInView(shown && inTimeline)
  // A task's timeline is a surface of its own beside the chat (its own tab), so it keeps its own live slot.
  const presence = useWidgetPresence(inTimeline ? `${message.chat_id}:timeline` : message.chat_id, widgetId, ref, shown && (stayed || !inTimeline), phone)
  const { active } = presence
  const mounted = active || presence.preload
  const target = useMemo(() => ({ workspace: null, conversation: message.chat_id, tabId: widgetTabId(widgetId, inTimeline),
    widget: { id: widgetId, originMessageId: message.id, messageId: slotMessageId, data: widget.data ?? {}, senderId } }), [widgetId, message.id, message.chat_id, slotMessageId, senderId, widget.data, inTimeline])
  const kind = `${widget.app}.${widget.view}`
  useEffect(() => {
    if (!active || phone || !ref.current) return
    const token = extensionViewStore.claim(kind, { chatId: message.chat_id, accountId: user?.id, tabId: target.tabId, widget: target.widget, element: ref.current })
    return () => extensionViewStore.release(kind, token)
  }, [active, phone, kind, message.chat_id, user?.id, target, ref])
  const painted = extensionViewStore.paintedPages.has(residentPageKey(kind, residentPlace({ chatId: message.chat_id, tabId: target.tabId, widget: target.widget })))
  return <div className="w-[420px] max-w-full min-w-0" data-widget-bubble={slotMessageId} data-widget-id={widgetId}>
    <WidgetFrame height={height} element={ref}>
      {phone ? null : <WidgetSnapshot widgetId={widgetId} element={ref} text={widget.text} visible={!active || !painted} inactive={!active} />}
      {mounted ? phone ? <PhoneAppFrame
        kind={kind} tabId={target.tabId} chatId={message.chat_id} widget={target.widget}
        placeholder={<WidgetLoading text={widget.text} />}
        onOpenWith={detail => window.dispatchEvent(new CustomEvent(APP_OPEN_WITH_EVENT, { detail }))}
        testId="widget-frame" missingTestId="widget-frame-missing"
      /> : null : <>
        {phone ? <WidgetLoading text={widget.text} loading={false} /> : null}
        <Button variant="ghost" className="absolute inset-0 h-full min-h-0 cursor-pointer rounded-none p-0" aria-label={t('message.reference.locateActive')} onClick={presence.locate} data-widget-locate>{null}</Button>
      </>}
    </WidgetFrame>
    {/* The link follows the text: an outgoing bubble keeps its time at the right of this line. */}
    <p className="whitespace-pre-wrap break-words text-[length:var(--font-caption)] text-[var(--text-secondary)]">
      <span data-widget-text>{widget.text}</span>
      {!mounted ? <>{' · '}<Button variant="ghost" className="inline h-auto min-h-0 cursor-pointer border-0 p-0 align-baseline text-[length:inherit] font-normal leading-[inherit] underline underline-offset-2 [&:hover:not([data-disabled])]:bg-transparent hover:text-[var(--text-primary)] max-[719px]:min-h-0" onClick={presence.locate}>{t('message.reference.locateActive')}</Button></> : null}
    </p>
  </div>
})

const WidgetUnavailable = observer(function WidgetUnavailable({ widget, reason, chatId }: { widget: WidgetMessage; reason: string; chatId: string }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { ref, shown } = useConversationVisibility(true)
  const [sources, setSources] = useState<{ chatId: string; userId: string; shared: ReadonlyMap<string, SharedPackage>; market: readonly MarketOffer[] } | null>(null)
  const [cue, setCue] = useState(0)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const canOffer = reason === 'missing' || reason === 'view'
  useEffect(() => subscribeSharedPackages(changed => { if (changed === chatId) setCue(cue => cue + 1) }), [chatId])
  useEffect(() => {
    setSources(null)
    setError('')
    if (!shown || !canOffer || !appsHere || !user?.id) return
    let live = true
    void Promise.all([
      sharedPackagesOf(chatId, user.id).catch(error => {
        log.warn({ error: messageForUser(error), chatId }, 'widget App packages could not be read')
        return new Map<string, SharedPackage>()
      }),
      appsHere.marketOffers().then(result => {
        if (live && !result.success) setError(messageForUser(result.error))
        return result.data ?? []
      }, error => { if (live) setError(messageForUser(error)); return [] }),
    ]).then(([shared, market]) => { if (live) setSources({ chatId, userId: user.id, shared, market }) })
    return () => { live = false }
  }, [shown, canOffer, chatId, user?.id, cue])
  const offer = canOffer && sources?.chatId === chatId && sources.userId === user?.id
    ? widgetInstallOffer(availableInstallOffers(sources.shared, sources.market, installedExtensionsStore.manifests, installedExtensionsStore.origins),
      widget.app, widget.view, platform.kind === 'electron' ? 'desktop' : 'phone') : null
  const install = async () => {
    if (!appsHere || !offer) return
    setInstalling(true)
    setError('')
    try {
      const result = offer.from.kind === 'shared'
        ? await appsHere.installAttachment({ ...installPackageOf(offer.from.card), chatId })
        : await appsHere.installFromMarket({ ref: { extensionId: offer.from.extensionId, version: offer.from.version }, chatId })
      if (!result.success) throw new Error(result.error)
      if (result.data && isInstallRefused(result.data)) setError(refusedLine(result.data))
    } catch (error) { setError(messageForUser(error)) }
    finally { setInstalling(false) }
  }
  return <div ref={ref} className="max-w-full min-w-0">
    <p className="whitespace-pre-wrap break-words">{widget.text}</p>
    <p className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t(`message.widgetUnavailable.${reason}`)}{' '}
      {offer ? <Button size="sm" variant="ghost" disabled={installing} onClick={() => void install()} data-widget-install>{t('chatArea.openWith.install')}</Button> : null}
    </p>
    {error ? <p role="alert">{error}</p> : null}
  </div>
})
