/** @jsxImportSource solid-js */
import { render } from 'solid-js/web';
import type { PasswordRequestView } from '@gugu/core/shared/passwordBetaProtocol';
import type { ChatContext } from './chat-context';
import { ChatTranslationProvider } from './localization';
import { PasswordRequestCard } from './components/rows/message/PasswordRequestCard';

/**
 * The card of a pending password request, outside a transcript: a session's `password` Ask draws it above the composer
 * (the host's own surface, React). The same card a transcript draws for an older request; disposed by the return value.
 */
export function mountPasswordRequestCard(parent: HTMLElement, request: PasswordRequestView, context: Pick<ChatContext, 'translate' | 'locale'>): () => void {
  return render(() => <ChatTranslationProvider value={context}><PasswordRequestCard request={request} /></ChatTranslationProvider>, parent);
}
