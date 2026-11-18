import { LIBRARY_TABS, type LibraryTab } from '../library-tabs';

/**
 * API 52: `contributes.hostLinks` points to host-owned pages. The `library:`
 * identifiers are kept so installed manifests continue to open their destinations.
 */
export const HOST_LINKS_API_VERSION = 52;
export const HOST_LINK_MAX = 4;

export type HostLink = `library:${LibraryTab}`;
export const HOST_LINKS = LIBRARY_TABS.map((tab) => `library:${tab}` as const) as unknown as readonly [HostLink, ...HostLink[]];

const HOST_LINK_TARGETS = {
  'library:prompts': { view: 'settings', section: 'prompts' },
  'library:agents': { view: 'apps', params: { marketPage: 'agents' } },
  'library:integrations': { view: 'apps', params: { marketPage: 'connectors' } },
  'library:mcp': { view: 'apps', params: { marketPage: 'connectors', installedSection: 'connectors' } },
  'library:themes': { view: 'settings', section: 'general' },
} as const satisfies Record<HostLink, unknown>;

export function hostLinkTarget(link: HostLink) {
  return HOST_LINK_TARGETS[link];
}
