import type { HostCatalog } from '../../../../shared/host-localization';

/**
 * @@@session-host-copy — what the session side writes for a person to read, in the host's language: agent system
 * notifications (@@@5301), and the sentences a device answers to a UI that shows them as the device's own words
 * (integration setup, session options). The block lives in `apps/desktop/shared/host-localization.ts` (`sessionHost`).
 *
 * Injected by the host, not imported from its locale store: the session page is a cohesive module, and that store has
 * module state — imported from here it is a copy whose value the host never sets. The host injects once at startup and
 * again on a language change. Not injected means wiring is broken ⇒ throw; ❌ fall back to one language.
 */
export type SessionHostCopy = HostCatalog['sessionHost'];

let injected: SessionHostCopy | null = null;

export function setSessionHostCopy(next: SessionHostCopy): void {
  injected = next;
}

export function sessionHostCopy(): SessionHostCopy {
  if (!injected) throw new Error('the session host copy was never injected by the host');
  return injected;
}
