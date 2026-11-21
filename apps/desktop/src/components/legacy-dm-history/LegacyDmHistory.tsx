import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { useMobileShell } from '@/hooks/useMobileShell';
import { useDebounce } from '@/session/renderer/lib/hooks/useDebounce';
import { messageForUser } from '@/lib/userFacingError';
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
import { mergeLegacyMessages, type LegacyDm, type LegacyDmScope } from './data';
import { legacyDmList, legacyDmMessages } from './legacyDmReplicas';
import { retryOf } from '@/lib/replica';
import { useReplicaPages } from '@/lib/replicaPages';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { legacyMessageBody } from './message-body';

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
  const list = useReplicaPages(legacyDmList, owner.ownerUserId ? [sessionId ?? null, search] : null, (page) => page.after);
  // A chat on two pages (ownership is decided after a page is read) is listed once.
  const rows = [...new Map(list.pages.flatMap((page) => page.rows).map((row) => [row.id, row])).values()];
  // undefined = not chosen yet: a session's history with exactly one chat opens it; back (null) shows the list.
  const [picked, setSelected] = useState<LegacyDm | null | undefined>(undefined);
  const only = sessionId && list.pages.length > 0 && rows.length === 1 && !list.more ? rows[0] : null;
  const selected = picked === undefined ? only : picked;
  const scope = list.pages[0]?.scope ?? null;
  const loading = list.first.state === 'unknown' || list.loadingMore;
  const failed = list.first.state === 'error' ? list.first : list.moreFailed;
  const title = translate(sessionId ? 'legacyDm.history' : 'legacyDm.archive');
  return <>
    <PaneHeader title={selected ? selected.name ?? translate('legacyDm.chatNumber', { number: selected.publicId }) : title}
      subtitle={translate('legacyDm.readOnly')} titleLevel="panel" mobile={mobile}
      leading={selected ? <IconButton aria-label={translate('common.back')} onClick={() => setSelected(null)}><ChevronLeft /></IconButton> : undefined}
      actions={<IconButton aria-label={translate('common.close')} onClick={onClose}><X /></IconButton>} />
    {selected && scope ? <LegacyDmTranscript key={selected.id} scope={scope} chat={selected} mobile={mobile} /> : <>
      <div className="px-4 py-3"><SearchField value={query} onChange={event => setQuery(event.target.value)} placeholder={translate('legacyDm.search')} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {rows.map(row => <ListRow key={row.id} title={row.name ?? translate('legacyDm.chatNumber', { number: row.publicId })}
          subtitle={<time dateTime={row.updatedAt}>{formatCalendarDate(Date.parse(row.updatedAt), locale)}</time>}
          trailing={<Button size="sm" variant="secondary" onClick={() => setSelected(row)}>{translate('sessionHistory.open')}</Button>} />)}
        {list.pages.length > 0 && !loading && !failed && rows.length === 0 && !list.more && <PaneEmptyState caption={translate('legacyDm.empty')} />}
        {failed && <><PaneEmptyState caption={translate('legacyDm.failed')} hint={messageForUser(failed.error)} /><Button variant="ghost" onClick={retryOf(failed)}>{translate('common.retry')}</Button></>}
        {loading && <LoadingIndicator size="panel" ariaLabel={translate('sessionImport.previewLoading')} />}
        {list.more && <Button variant="ghost" onClick={list.more}>{translate('legacyDm.more')}</Button>}
      </div>
    </>}
  </>;
}

function LegacyDmTranscript({ scope, chat, mobile }: { scope: LegacyDmScope; chat: LegacyDm; mobile: boolean }) {
  const owner = useAvatarIdentity(scope.ownerUserId);
  const { t } = useTranslation('messaging');
  const { translate, locale } = useSessionMessages();
  const preview = useMessageFilePreview({ mobile, visible: true, closeRightSurfaces: () => {}, toast: previewToast, readOnly: true });
  const history = useReplicaPages(legacyDmMessages, [scope.agentUserId ?? null, chat.id], (page) => (page.beforeSeq === null ? null : String(page.beforeSeq)));
  const messages = useMemo(() => history.pages.reduce<MessageItem[]>((shown, page) => mergeLegacyMessages(page.rows, shown), []), [history.pages]);
  const loading = history.first.state === 'unknown' || history.loadingMore;
  const failed = history.first.state === 'error' ? history.first : history.moreFailed;
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef<{ top: number; height: number } | null>(null);
  // @@@effect-flow(dom) - keeps the reading position when older messages are prepended (DOM measure of the rows in hand)
  useLayoutEffect(() => {
    if (!scroll.current) return;
    scroll.current.scrollTop = position.current ? position.current.top + scroll.current.scrollHeight - position.current.height : scroll.current.scrollHeight;
    position.current = null;
  }, [messages]);
  const older = () => {
    // Where the reader is when older messages are asked: kept when they land above.
    if (scroll.current) position.current = { top: scroll.current.scrollTop, height: scroll.current.scrollHeight };
    history.more?.();
  };
  return <>
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto py-3" data-testid="legacy-dm-messages">
      {history.more && <Button variant="ghost" onClick={older}>{translate('legacyDm.older')}</Button>}
      {messages.map(message => <ReadOnlyMessageBubble key={message.id} message={message} mobile={mobile} fileCardsOnly
        body={legacyMessageBody(message, t('message.retracted'))}
        sender={message.is_mine ? { display_name: owner?.display_name ?? '', avatar: owner?.avatar, type: 'human' }
          : chat.agent && message.sender_user_id === chat.agent.id ? chat.agent : { display_name: translate('legacyDm.unknownSender') }}
        timestamp={<time dateTime={message.created_at}>  {formatCalendarDate(Date.parse(message.created_at), locale)}</time>}
        onOpenFile={file => preview.open(file, message)} />)}
      {loading && <LoadingIndicator size="panel" ariaLabel={translate('sessionImport.previewLoading')} />}
      {failed && <><PaneEmptyState caption={translate('legacyDm.failed')} hint={messageForUser(failed.error)} /><Button variant="ghost" onClick={retryOf(failed)}>{translate('common.retry')}</Button></>}
      {history.pages.length > 0 && !loading && !failed && !messages.length && <PaneEmptyState caption={translate('legacyDm.empty')} />}
    </div>
    {preview.panel}
  </>;
}
