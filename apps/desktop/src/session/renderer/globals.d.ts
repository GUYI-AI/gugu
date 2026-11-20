import type { NativeFileReadIpc } from '../../../electron/nativeFileHost'
import type { AttachmentUploadIpc } from '../../../electron/attachmentUploadHost'
declare module 'react-syntax-highlighter';
declare module 'react-syntax-highlighter/dist/esm/styles/prism';

declare global {
  interface Window {
    electronAPI: NativeFileReadIpc & AttachmentUploadIpc & {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      eventSend: (channel: string, data: unknown) => void;
      eventOn: (channel: string, cb: (data: unknown) => void) => () => void;
      getPathForFile: (file: File) => string;
      requestWirePort: (channel: string) => Promise<void>;
    };
  }
}

export {};
