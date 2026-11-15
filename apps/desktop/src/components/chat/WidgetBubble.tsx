import { observer } from 'mobx-react-lite'
import { useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { useReplica } from '../../lib/replica'
import { Unknown } from '../ui/Unknown'
import { marketOffers, useMarketOffers } from '../appSlot/marketOffers'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { parseWidgetMessage, type WidgetMessage } from '@gugu/core/shared/ui/widgetModels'
import { platform } from '../../platform'
import { appsHere } from '../appSlot/appsHere'
import { HERE_HOST } from '../appSlot/hereHost'
import { PhoneAppFrame } from '../appSlot/PhoneAppFrame'
import { Button } from '../ui/Button'
import { APP_OPEN_WITH_EVENT } from '../../session/shared/extensions/app-runtime-protocol'
import { installedExtensions, useInstalledApps } from '../../session/renderer/features/extensions/installed-extensions'
import { RefreshFailed } from '../ui/RefreshFailed'
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
import { installPackageOf } from '../extensionBundle/sharedPackages'
import { sharedAppPackages } from '../extensionBundle/packageReplicas'
import { availableInstallOffers, widgetInstallOffer, type MarketOffer } from '../extensionBundle/installOffers'

const NO_MARKET: readonly MarketOffer[] = []

type Message = Pick<MessageItem, 'id' | 'chat_id' | 'sender_user_id' | 'content'>

export function WidgetBubble({ message, slotMessageId = message.id, referenceWidget }: { message: Message; slotMessageId?: string; referenceWidget?: ResolvedWidget }) {
  const { t } = useTranslation('messaging')
  const widget = useMemo(() => referenceWidget?.widget ?? parseWidgetMessage(message.content), [message.content, referenceWidget])
  const installedReading = useInstalledApps(HERE_HOST)
  if (!widget) return <span>{t('message.widget')}</span>
  // No App store here (the web): the widget's App is not on this platform, said by `reason` below.
  // Not read yet: the message's own text (its size is the App's to say), ❌ 「没有装」 for an App that may be installed.
  if (HERE_HOST && installedReading.state === 'unknown') return <p>{widget.text}</p>
  if (installedReading.state === 'error') {
    return <div><p>{widget.text}</p><RefreshFailed error={installedReading.error} onRetry={() => { if (HERE_HOST) void installedExtensions.refresh(HERE_HOST) }} /></div>
  }
  const installed = installedReading.state === 'value' ? installedReading.value : null
  const manifest = installed?.manifestFor(widget.app)
  const tab = manifest?.contributes.tabs.find(tab => tab.name === widget.view)
  const reason = !appsHere || (manifest?.platforms && !manifest.platforms.includes(platform.kind === 'electron' ? 'desktop' : 'phone')) ? 'platform'
    : !manifest || !installed ? 'missing' : !installed.isEnabled(widget.app) ? 'disabled' : !tab?.widget ? 'view' : null
  if (reason || !tab?.widget) return <WidgetUnavailable widget={widget} reason={reason ?? 'view'} chatId={message.chat_id} />
  return referenceWidget ? <WidgetView key={`${referenceWidget.id}:${manifest?.version}`} message={message} slotMessageId={slotMessageId} resolved={referenceWidget} height={widget.height ?? tab.widget.height} />
    : <OriginalWidgetView message={message} slotMessageId={slotMessageId} height={widget.height ?? tab.widget.height} text={widget.text} />
}

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
      {phone ? null : <WidgetSnapshot widgetId={widgetId} text={widget.text} visible={!active || !painted} inactive={!active} />}
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
      {!mounted ? <>{' '}<Button variant="ghost" className="inline h-auto min-h-0 cursor-pointer border-0 p-0 align-baseline text-[length:inherit] font-normal leading-[inherit] underline underline-offset-2 [&:hover:not([data-disabled])]:bg-transparent hover:text-[var(--text-primary)] max-[719px]:min-h-0" onClick={presence.locate}>{t('message.reference.locateActive')}</Button></> : null}
    </p>
  </div>
})

function WidgetUnavailable({ widget, reason, chatId }: { widget: WidgetMessage; reason: string; chatId: string }) {
  const { t } = useTranslation('messaging')
  const installed = useInstalledApps(HERE_HOST)
  const { user } = useAuth()
  const { ref, shown } = useConversationVisibility(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const canOffer = reason === 'missing' || reason === 'view'
  // Asked once the bubble is on screen: this chat's shared packages (refreshed when one is sent) and the market's Apps.
  const asked = shown && canOffer && !!appsHere && !!user?.id
  const shared = useReplica(sharedAppPackages, asked ? [chatId] : null)
  const marketReading = useMarketOffers(asked)
  // @@@reading-default - the market unreadable: the offer is looked for among what is shared here only, and the failure is said below
  const market = marketReading.state === 'value' ? marketReading.value : marketReading.state === 'error' ? NO_MARKET : null
  const offer = asked && shared.state === 'value' && market && installed.state === 'value'
    ? widgetInstallOffer(availableInstallOffers(shared.value, market, installed.value.manifests, installed.value.origins),
      widget.app, widget.view, platform.kind === 'electron' ? 'desktop' : 'phone') : null
  /** Asked and not answered yet: the offer's place is held at its size. */
  const offerUnknown = asked && (shared.state === 'unknown' || marketReading.state === 'unknown' || installed.state === 'unknown')
  const readFailed = shared.state === 'error' ? shared.error : marketReading.state === 'error' ? marketReading.error : null
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
      {offer ? <Button size="sm" variant="ghost" disabled={installing} onClick={() => void install()} data-widget-install>{t('chatArea.openWith.install')}</Button> : offerUnknown ? <Unknown className="h-6 w-14 align-middle" /> : null}
    </p>
    {error ? <p role="alert">{error}</p> : null}
    <RefreshFailed error={readFailed} onRetry={() => { void sharedAppPackages.refresh(chatId); void marketOffers.refresh() }} />
  </div>
}
