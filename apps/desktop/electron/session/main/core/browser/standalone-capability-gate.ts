import type { BrowserKernelKind } from '@shared/browser-kernel';

export type CapabilityGateFacts = {
  /** The tab shows a page of another machine's session (its localhost requests belong to that machine). */
  remoteSession(browserId: string): boolean;
  /** The person turned on "relax CORS for localhost" in the browser settings. */
  relaxCorsForLocalhost(): Promise<boolean>;
};

/**
 * The one place that holds a tab on the built-in browser although the standalone browser was chosen: what the standalone Chrome
 * cannot do the way the built-in browser does ("独立端不支持的能力 → Built-in"). A tab snapshots its engine when it registers, so a
 * setting changed later applies to tabs opened after it.
 * - remote-session tab: the built-in browser's session forwards the page's localhost requests to the other machine
 *   (remote-loopback-requests.ts, #6264); the standalone Chrome would send them to this computer's own ports.
 * - relax CORS for localhost: applied through the built-in browser's request hooks (browser-cors-relaxation.ts); the standalone
 *   Chrome has no equivalent.
 */
export async function kernelAfterCapabilityGate(
  wanted: BrowserKernelKind,
  browserId: string,
  facts: CapabilityGateFacts,
  /** `adoptsWindow`: the tab shows a window the standalone Chrome already created for a page, which no built-in tab can show. */
  options: { adoptsWindow?: boolean } = {}
): Promise<BrowserKernelKind> {
  if (wanted !== 'standalone') return wanted;
  if (facts.remoteSession(browserId)) return 'builtin';
  if (options.adoptsWindow) return 'standalone';
  if (await facts.relaxCorsForLocalhost()) return 'builtin';
  return 'standalone';
}
