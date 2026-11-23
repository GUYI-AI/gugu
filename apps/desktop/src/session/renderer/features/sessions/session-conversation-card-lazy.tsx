import { lazy, Suspense, type ComponentProps } from 'react';

// The card is drawn only when it opens. Loaded then: its imports (agent bindings, remote hosts …) lead back to the session
// page's tab registry, which registers the very tab items that draw it — a static import would close that loop.
const Card = lazy(() => import('./session-conversation-card').then((module) => ({ default: module.SessionConversationCard })));

export function LazySessionConversationCard(props: ComponentProps<typeof Card>) {
  return <Suspense fallback={null}><Card {...props} /></Suspense>;
}
