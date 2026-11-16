import { codemirror } from '@/session/app-runtime/codemirror-entry';
const guest = window as any;
guest.gugu.codemirror = async () => codemirror;
await import('@/session/app-runtime/ui/ui-entry');
// The shipped App runs unmodified, with controlled host transport and file data.
// @ts-expect-error The preinstalled App is an unbundled ES module.
await import('../../../../../preinstalled-apps/workspace/app.js');
