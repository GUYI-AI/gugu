import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { useMobileShell } from '@/hooks/useMobileShell';
import { useDebounce } from '@/session/renderer/lib/hooks/useDebounce';
import { messageForUser } from '@/lib/userFacingError';
import { rendererLogger } from '@/lib/log';
import { ChevronLeft, X } from '@/lib/icons';
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages';
import { formatCalendarDate } from '@/i18n/format';
import { Sheet } from '../ui/Sheet';
import { PaneHeader } from '../ui/Pane';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { ListRow } from '../ui/ListRow';
import { SearchField } from '../ui/SearchField';
import { PaneEmptyState } from '../ui/PaneEmptyState';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { TaskChatFilePreviewHost } from '../assistant/TaskChatFilePreviewHost';
import { ReadOnlyMessageBubble } from '../chat/ReadOnlyMessageBubble';
import { useMessageFilePreview } from '../chat/useMessageFilePreview';
import { notify } from '@/lib/notices';
import { useLegacyDmOwner } from './useLegacyDmOwner';
import { readLegacyDmList, readLegacyDmMessages, mergeLegacyMessages, type LegacyDm, type LegacyDmScope } from './data';
import { legacyDmList, legacyDmMessages } from './legacyDmReplicas';
import { useReplica } from '@/lib/replica';
import { legacyMessageBody } from './message-body';

const log = rendererLogger('legacy-dm-history');
const previewToast = (title: string, tier: 'error', description?: string) => { notify({ title, tier, description }); };

export function LegacyDmHistoryDialog({ sessionId, onClose }: { sessionId?: string; onClose: () => void }) {
  const ownerUserId = useLegacyDmOwner();
  const { translate } = useSessionMessages();
  const mobile = useMobileShell();
  if (!ownerUserId) return null;
  return <Sheet onClose={onClose} desktopWidth="min(768px, 100%)" desktopHeight="680px" desktopMaxHeight="calc(100dvh - 32px)"
    fullScreenMobile ariaLabel={translate(sessionId ? 'legacyDm.history' : 'legacyDm.archive')} testId="legacy-dm-history">
    <TaskChatFilePreviewHost mobile={mobile}>
      <LegacyDmReader key={`${ownerUserId}:${sessionId ?? ''}`} scope={{ ownerUserId }} sessionId={sessionId} mobile={mobile} onClose={onClose} />
    </TaskChatFilePreviewHost>
  </Sheet>;
}

function LegacyDmReader({ scope: owner, sessionId, mobile, onClose }: {
  scope: LegacyDmScope; sessionId?: string; mobile: boolean; onClose: () => void;
}) {
  const { translate, locale } = useSessionMessages();
  const [query, setQuery] = useState('');
  const search = useDebounce(query, 200);
  const args: [string | null, string] = [sessionId ?? null, search];
  const reading = useReplica(legacyDmList, owner.ownerUserId ? args : null);
  const list = reading.state === 'value' ? reading.value : null;
  // undefined = not chosen yet: a session's history with exactly one chat opens it; back (null) shows the list.
  const [picked, setSelected] = useState<LegacyDm | null | undefined>(undefined);
  const only = sessionId && list && list.rows.length === 1 && !list.after ? list.rows[0] : null;
  const selected = picked === undefined ? only : picked;
  const scope = list?.scope ?? null;
  const [paging, setPaging] = useState(false);
  const [pageError, setPageError] = useState<unknown>(null);
  const loading = reading.state === 'unknown' || paging;
  const error = reading.state === 'error' ? reading.error : pageError;

  const more = async () => {
    if (!list?.scope || !list.after || paging) return;
    const entry = legacyDmList.at(...args);
    setPaging(true); setPageError(null);
    try {
      const page = await readLegacyDmList(list.scope, list.after, search);
      entry.set(current => current && { ...current, rows: [...new Map([...current.rows, ...page.rows].map(row => [row.id, row])).values()], after: page.after });
    } catch (cause) { log.error({ error: cause }, 'legacy archive page read failed'); setPageError(cause); }
    finally { setPaging(false); }
  };
  // A failed first read is read again (prefetch reads an entry without a value); a failed page is asked again.
  const retry = () => { if (reading.state === 'error') void legacyDmList.prefetch(...args); else void more(); };
  const title = translate(sessionId ? 'legacyDm.history' : 'legacyDm.archive');
  return <>
    <PaneHeader title={selected ? selected.name ?? translate('legacyDm.chatNumber', { number: selected.publicId }) : title}
      subtitle={translate('legacyDm.readOnly')} titleLevel="panel" mobile={mobile}
      leading={selected ? <IconButton aria-label={translate('common.back')} onClick={() => setSelected(null)}><ChevronLeft /></IconButton> : undefined}
      actions={<IconButton aria-label={translate('common.close')} onClick={onClose}><X /></IconButton>} />
    {selected && scope ? <LegacyDmTranscript key={selected.id} scope={scope} chat={selected} mobile={mobile} /> : <>
      <div className="px-4 py-3"><SearchField value={query} onChange={event => setQuery(event.target.value)} placeholder={translate('legacyDm.search')} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {list?.rows.map(row => <ListRow key={row.id} title={row.name ?? translate('legacyDm.chatNumber', { number: row.publicId })}
          subtitle={<time dateTime={row.updatedAt}>{formatCalendarDate(Date.parse(row.updatedAt), locale)}</time>}
          trailing={<Button size="sm" variant="secondary" onClick={() => setSelected(row)}>{translate('sessionHistory.open')}</Button>} />)}
        {list && !paging && !error && list.rows.length === 0 && !list.after && <PaneEmptyState caption={translate('legacyDm.empty')} />}
        {error != null && <><PaneEmptyState caption={translate('legacyDm.failed')} hint={messageForUser(error)} /><Button variant="ghost" onClick={retry}>{translate('common.retry')}</Button></>}
        {loading && <LoadingIndicator size="panel" ariaLabel={translate('sessionImport.previewLoading')} />}
        {list?.after && <Button variant="ghost" disabled={loading} onClick={() => void more()}>{translate('legacyDm.more')}</Button>}
      </div>
    </>}
  </>;
}

function LegacyDmTranscript({ scope, chat, mobile }: { scope: LegacyDmScope; chat: LegacyDm; mobile: boolean }) {
  const owner = useAvatarIdentity(scope.ownerUserId);
  const { t } = useTranslation('messaging');
  const { translate, locale } = useSessionMessages();
  const preview = useMessageFilePreview({ mobile, visible: true, closeRightSurfaces: () => {}, toast: previewToast, readOnly: true });
  const args: [string | null, string] = [scope.agentUserId ?? null, chat.id];
  const reading = useReplica(legacyDmMessages, args);
  const page = reading.state === 'value' ? reading.value : null;
  const messages = page?.rows;
  const before = page ? page.beforeSeq : null;
  const [paging, setPaging] = useState(false);
  const [pageError, setPageError] = useState<unknown>(null);
  const loading = reading.state === 'unknown' || paging;
  const error = reading.state === 'error' ? reading.error : pageError;
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef<{ top: number; height: number } | null>(null);
  // @@@effect-flow(dom) - keeps the reading position when older messages are prepended (DOM measure of the rows in hand)
  useLayoutEffect(() => {
    if (!scroll.current) return;
    scroll.current.scrollTop = position.current ? position.current.top + scroll.current.scrollHeight - position.current.height : scroll.current.scrollHeight;
    position.current = null;
  }, [messages]);
  const older = async () => {
    if (before === null || paging) return;
    const entry = legacyDmMessages.at(...args);
    setPaging(true); setPageError(null);
    try {
      const next = await readLegacyDmMessages(scope, chat.id, before);
      if (scroll.current) position.current = { top: scroll.current.scrollTop, height: scroll.current.scrollHeight };
      entry.set(current => current && { rows: mergeLegacyMessages(next.rows, current.rows), beforeSeq: next.beforeSeq });
    } catch (cause) { log.error({ error: cause }, 'older legacy messages read failed'); setPageError(cause); }
    finally { setPaging(false); }
  };
  const retry = () => { if (reading.state === 'error') void legacyDmMessages.prefetch(...args); else void older(); };
  return <>
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto py-3" data-testid="legacy-dm-messages">
      {before !== null && <Button variant="ghost" disabled={loading} onClick={() => void older()}>{translate('legacyDm.older')}</Button>}
      {messages?.map(message => <ReadOnlyMessageBubble key={message.id} message={message} mobile={mobile} fileCardsOnly
        body={legacyMessageBody(message, t('message.retracted'))}
        sender={message.is_mine ? { display_name: owner?.display_name ?? '', avatar: owner?.avatar, type: 'human' }
          : chat.agent && message.sender_user_id === chat.agent.id ? chat.agent : { display_name: translate('legacyDm.unknownSender') }}
        timestamp={<time dateTime={message.created_at}>  {formatCalendarDate(Date.parse(message.created_at), locale)}</time>}
        onOpenFile={file => preview.open(file, message)} />)}
      {loading && <LoadingIndicator size="panel" ariaLabel={translate('sessionImport.previewLoading')} />}
      {error != null && <><PaneEmptyState caption={translate('legacyDm.failed')} hint={messageForUser(error)} /><Button variant="ghost" onClick={retry}>{translate('common.retry')}</Button></>}
      {messages && !paging && !error && !messages.length && <PaneEmptyState caption={translate('legacyDm.empty')} />}
    </div>
    {preview.panel}
  </>;
}
