import { externalLinkOpenRequestedChannel } from '@shared/events/appEvents';
import { events } from './ipc';
import { openWebLink } from './open-web-link';

export function wireExternalLinkRequests() {
  return events.on(externalLinkOpenRequestedChannel, ({ url }) => {
    openWebLink(url, 'app');
  });
}
