import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/Avatar';
import { PanelRight, Search, Settings } from '@/lib/icons';
import type { AssistantShellAssistant } from '@/lib/assistantShellBridge';
import { searchInChat } from '@renderer/features/global-search/search-session';

/**
 * What the row shows in its middle: the assistant (face and name; a click opens its profile), or the state the built-in page
 * says it is in when it cannot show it yet (`identity.*`, `provisioning.title`); null: nothing there.
 */
export type AssistantChatTopIdentity =
  | { kind: 'assistant'; assistant: Pick<AssistantShellAssistant, 'id' | 'display_name' | 'avatar'>; onOpen: () => void }
  | { kind: 'state'; state: 'loading' | 'none' | 'unreadable' | 'preparing' };

/**
 * The row above the conversation column of the assistant page (assistant-view.tsx): the assistant's face and name in the
 * middle; search, its settings gear and「展开面板」on the right. Also the row the host draws above the conversation beside an
 * App's page (app-conversation-frame.tsx, #1925): there without the gear unless the App declared the assistant's row, and
 * then only over the person's own assistant chat. The same row, from the same host data, never the App's.
 */
export function AssistantChatTop({ testIdPrefix, identity, chatId, onSettings, panelOpen, onExpand }: {
  testIdPrefix: 'assistant' | 'app-conversation';
  identity: AssistantChatTopIdentity | null;
  /** The conversation search looks in; none yet: search waits. */
  chatId: string | null;
  /** The gear; null: none drawn. */
  onSettings: (() => void) | null;
  panelOpen: boolean;
  onExpand: () => void;
}) {
  const { t } = useTranslation('assistant');
  return (
    <div className="ta-chat-top">
      {identity?.kind === 'assistant' ? (
        <button
          type="button"
          className="ta-identity"
          onClick={identity.onOpen}
          aria-label={t('top.profile', { name: identity.assistant.display_name })}
          data-testid={`${testIdPrefix}-identity`}
        >
          <Avatar name={identity.assistant.display_name} avatarUrl={identity.assistant.avatar} seed={identity.assistant.id} size={48} isAgent harnessBadge={false} />
          <span className="ta-identity-name">{identity.assistant.display_name}</span>
        </button>
      ) : identity?.kind === 'state' ? (
        <div className="ta-identity" role="status" data-state={identity.state} data-testid={`${testIdPrefix}-identity-state`}>
          <span className="ta-identity-name">{identity.state === 'preparing' ? t('provisioning.title') : t(`identity.${identity.state}`)}</span>
        </div>
      ) : null}
      <div className="ta-chat-actions">
        <button
          type="button"
          className="ta-circle"
          aria-label={t('top.search')}
          title={t('top.search')}
          disabled={!chatId}
          onClick={() => { if (chatId) searchInChat(chatId) }}
          data-testid={`${testIdPrefix}-search`}
        >
          <Search />
        </button>
        {onSettings ? (
          <button
            type="button"
            className="ta-circle"
            aria-label={t('top.settings')}
            title={t('top.settings')}
            onClick={onSettings}
            data-testid={`${testIdPrefix}-gear`}
          >
            <Settings />
          </button>
        ) : null}
        {panelOpen ? null : (
          <button
            type="button"
            className="ta-circle"
            aria-label={t('top.expand')}
            title={t('top.expand')}
            onClick={onExpand}
            data-testid={`${testIdPrefix}-panel-expand`}
          >
            <PanelRight />
          </button>
        )}
      </div>
    </div>
  );
}
