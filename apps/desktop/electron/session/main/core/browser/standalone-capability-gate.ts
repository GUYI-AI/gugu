import type { BrowserKernelKind } from '@shared/browser-kernel';

export type CapabilityGateFacts = {
  /** The tab shows a page of another machine's session (its localhost requests belong to that machine). */
  remoteSession(browserId: string): boolean;
  /** The person turned on "relax CORS for localhost" in the browser settings. */
  relaxCorsForLocalhost(): Promise<boolean>;
};

/** Not implemented yet. */
export async function kernelAfterCapabilityGate(wanted: BrowserKernelKind, _browserId: string, _facts: CapabilityGateFacts): Promise<BrowserKernelKind> {
  return wanted;
}
