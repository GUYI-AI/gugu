import { ipcRenderer } from 'electron';
import { createVaultLoginPage } from './session/main/core/browser/vault-browser-login-page';
import { VAULT_LOGIN_BRIDGE, VAULT_LOGIN_CHANNEL } from './session/main/core/browser/vault-browser-login-protocol';

// No contextBridge/exposeInMainWorld, page messages, debugger, console or observation registration.
if (process.isMainFrame) Object.defineProperty(globalThis, VAULT_LOGIN_BRIDGE, {
  value: createVaultLoginPage(request => ipcRenderer.sendSync(VAULT_LOGIN_CHANNEL, request)),
  configurable: false, writable: false,
});
