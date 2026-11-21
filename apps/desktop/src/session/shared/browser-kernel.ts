export type BrowserKernelKind = 'builtin' | 'standalone';
export type BrowserKernelAction = 'builtin' | 'download-and-switch' | 'cancel' | 'check-update' | 'remove';

/** Download state describes real bytes; an installed browser is reported only after archive verification. */
export type BrowserKernelStatus = {
  supported: boolean;
  selected: BrowserKernelKind;
  phase: 'idle' | 'downloading' | 'installing' | 'cancelling';
  asset: { version: string; downloadBytes: number } | null;
  installation: { version: string; installedBytes: number } | null;
  receivedBytes: number;
  totalBytes: number;
  error: string | null;
  update?: { version: string; reviewed: boolean } | null;
};
