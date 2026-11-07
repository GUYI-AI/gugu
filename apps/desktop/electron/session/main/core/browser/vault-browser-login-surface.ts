import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { anySignal } from '@gugu/core/shared/anySignal';
import { session, WebContentsView, type IpcMainEvent, type WebContents } from 'electron';
import type { AuditedCredentialUseLease, CredentialUseBinding } from './credential-use-contract';
import { assertCredentialWebsite } from './credential-website';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { remoteBrowserBinding } from './remote-loopback-requests';
import { protectVaultLoginNetwork } from './vault-browser-login-network';
import type { CredentialPermissionChecks } from './credential-permission';
import { VAULT_LOGIN_BRIDGE, VAULT_LOGIN_CHANNEL, VAULT_LOGIN_WORLD, VaultBrowserLoginError,
  type VaultLoginCompletion, type VaultLoginGateRequest, type VaultLoginReview, type VaultLoginSelection } from './vault-browser-login-protocol';

export type VaultLoginSurfaceIdentity = Readonly<{ loginSurfaceId: string; loginSurfaceEpoch: string;
  browserId: string; partition: string; contents: WebContents }>;
export type VaultLoginSurfaceHost = {
  browserId: string; partition: string; agentContents: WebContents;
  /** Trusted construction-time adapters; no Agent supplied booleans or approval callbacks. */
  isolationReady(): boolean;
  assertCurrent(binding: CredentialUseBinding): void;
  registerPrivateSurface(identity: VaultLoginSurfaceIdentity): () => void;
  permission: CredentialPermissionChecks;
};
type Pending = { nonce: string; phase: 'fill' | 'submit'; binding: CredentialUseBinding;
  lease: AuditedCredentialUseLease; account?: Buffer; password?: Buffer };
const KEYS = ['requestId', 'useId', 'accountId', 'installationId', 'agentId', 'sessionId', 'browserId',
  'loginSurfaceId', 'loginSurfaceEpoch', 'documentId', 'frameId', 'formFingerprint',
  'credentialId', 'credentialVersion', 'lockEpoch', 'origin', 'operation'] as const;

/**
 * A host-private login surface. NEVER adopt into BrowserPageRuntime/registry, attach a debugger,
 * create a pane transport, wire page events/console or pass this view to an Agent target.
 * Product entrypoints remain unconnected until the integration's isolation/audit/UI checks pass.
 */
export class VaultBrowserLoginSurface {
  readonly loginSurfaceId = randomUUID();
  readonly loginSurfaceEpoch = randomUUID();
  private readonly view: WebContentsView;
  private readonly contents: WebContents;
  private readonly network: ReturnType<typeof protectVaultLoginNetwork>;
  private reviewValue?: VaultLoginReview;
  private binding?: CredentialUseBinding;
  private pending?: Pending;
  private fault = false;
  private fillAttempted = false;
  private submissionAttempted = false;
  private documentRevision = 0;
  private navigationUrl = '';
  private retiring = false;
  private retired = false;
  private releasePrivate: (() => void) | undefined;
  private leaseSource?: AuditedCredentialUseLease;
  private lease?: AuditedCredentialUseLease;
  private readonly personDocuments = new Set<string>();

  constructor(private readonly host: VaultLoginSurfaceHost, private readonly origin: string) {
    if (!host.permission || typeof host.permission.revalidate !== 'function'
      || typeof host.permission.assertCurrent !== 'function' || !(host.permission.signal instanceof AbortSignal)) throw new VaultBrowserLoginError();
    this.host = Object.freeze({ browserId: host.browserId, partition: host.partition, agentContents: host.agentContents,
      isolationReady: host.isolationReady.bind(host), assertCurrent: host.assertCurrent.bind(host),
      registerPrivateSurface: host.registerPrivateSurface.bind(host), permission: Object.freeze({ signal: host.permission.signal,
        revalidate: host.permission.revalidate.bind(host.permission), assertCurrent: host.permission.assertCurrent.bind(host.permission) }) });
    assertCredentialWebsite(origin, origin);
    this.assertTarget(true);
    const preload = join(__dirname, 'vault-browser-login-preload.js');
    if (!existsSync(preload)) throw new VaultBrowserLoginError();
    const ses = session.fromPartition(host.partition);
    if (ses !== host.agentContents.session) throw new VaultBrowserLoginError();
    this.view = new WebContentsView({ webPreferences: {
      session: ses, preload, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, devTools: false, navigateOnDragDrop: false, focusOnNavigation: false, spellcheck: false,
    } });
    this.contents = this.view.webContents;
    this.view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
    this.view.setVisible(false);
    this.contents.setBackgroundThrottling(false);
    try { this.network = protectVaultLoginNetwork(ses, this.contents.id, origin); }
    catch { this.contents.close(); throw new VaultBrowserLoginError(); }
    try {
      this.releasePrivate = this.host.registerPrivateSurface({ loginSurfaceId: this.loginSurfaceId, loginSurfaceEpoch: this.loginSurfaceEpoch,
        browserId: host.browserId, partition: host.partition, contents: this.contents });
      if (typeof this.releasePrivate !== 'function') throw new VaultBrowserLoginError();
    } catch { this.network.close(); this.contents.close(); throw new VaultBrowserLoginError(); }
    this.contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.contents.on('will-frame-navigate', event => {
      try { if (!event.isMainFrame) throw new VaultBrowserLoginError(); assertCredentialWebsite(event.url, origin); }
      catch { event.preventDefault(); }
    });
    this.contents.on('will-redirect', event => {
      try { assertCredentialWebsite(event.url, origin); } catch { event.preventDefault(); }
    });
    this.contents.on('did-start-navigation', event => { if (event.isMainFrame) { this.documentRevision++; this.navigationUrl = event.url; } });
    this.contents.on('preload-error', () => { this.fault = true; });
    this.contents.on('render-process-gone', (_event, details) => {
      if (!this.retiring || details.reason !== 'clean-exit') this.fault = true;
    });
    this.contents.on('unresponsive', () => { this.fault = true; });
    this.contents.once('destroyed', () => {
      this.retired = this.retiring;
      if (!this.retired) this.fault = true;
      this.network.close();
      try { this.releasePrivate?.(); } catch { this.fault = true; this.retired = false; }
      this.releasePrivate = undefined;
    });
    this.contents.ipc.on(VAULT_LOGIN_CHANNEL, (event, request: unknown) => this.gate(event, request));
  }

  async load(url: string): Promise<void> {
    if (this.fillAttempted) throw new VaultBrowserLoginError();
    assertCredentialWebsite(url, this.origin);
    try { await this.contents.loadURL(url); this.assertLive(); } catch { throw new VaultBrowserLoginError(); }
  }

  async review(selection: VaultLoginSelection) {
    if (this.fillAttempted) throw new VaultBrowserLoginError();
    const value = await this.call<VaultLoginReview>('review', [selection, this.origin]);
    if (!value || typeof value.documentId !== 'string' || typeof value.formFingerprint !== 'string') throw new VaultBrowserLoginError();
    assertCredentialWebsite(value.destination, this.origin);
    this.reviewValue = Object.freeze({ ...value });
    return Object.freeze({ loginSurfaceId: this.loginSurfaceId, loginSurfaceEpoch: this.loginSurfaceEpoch,
      documentId: value.documentId, formFingerprint: value.formFingerprint, frameId: this.frameId(), origin: this.origin });
  }

  /** Called only by storage's fixed sink, with short-lived buffers. No value is put into script source. */
  async fill(binding: CredentialUseBinding, lease: AuditedCredentialUseLease, account: Buffer, password: Buffer): Promise<void> {
    if (this.fillAttempted) throw new VaultBrowserLoginError();
    this.fillAttempted = true;
    this.binding = Object.freeze({ ...binding });
    try {
      this.leaseSource = lease;
      this.lease = Object.freeze({ signal: anySignal([lease.signal, this.host.permission.signal]), revokedSignal: lease.revokedSignal,
        assertCurrent: lease.assertCurrent.bind(lease),
        claimSubmission: lease.claimSubmission.bind(lease), prepareSubmission: lease.prepareSubmission.bind(lease) });
      lease = this.lease;
      await this.host.permission.revalidate({ stage: 'before_fill', target: this.binding });
      this.assertUse(binding, true); lease.assertCurrent(); lease.signal.throwIfAborted();
      this.network.beginSensitive();
      await this.operation({ phase: 'fill', nonce: randomUUID(), binding, lease, account, password });
      this.assertUse(binding, true); lease.assertCurrent(); lease.signal.throwIfAborted();
    } catch { throw new VaultBrowserLoginError(); }
  }

  async submit(binding: CredentialUseBinding, lease: AuditedCredentialUseLease): Promise<void> {
    if (!this.fillAttempted || this.submissionAttempted || lease !== this.leaseSource || !this.lease) throw new VaultBrowserLoginError();
    this.submissionAttempted = true;
    lease = this.lease;
    try {
      this.assertUse(binding, true); lease.assertCurrent(); lease.signal.throwIfAborted();
      await lease.prepareSubmission();
      this.assertUse(binding, true); lease.assertCurrent(); lease.signal.throwIfAborted();
      await this.host.permission.revalidate({ stage: 'before_submit', target: this.binding! });
      this.assertUse(binding, true); lease.assertCurrent(); lease.signal.throwIfAborted();
      await this.operation({ phase: 'submit', nonce: randomUUID(), binding, lease });
      this.assertCurrent(binding); lease.signal.throwIfAborted();
    } catch { throw new VaultBrowserLoginError(); }
  }

  /** Lifecycle guard excludes the pre-submit document and intentional retirement. */
  assertCurrent(binding: CredentialUseBinding): void {
    this.host.permission.assertCurrent(binding);
    this.assertSurface(binding); this.assertTarget(); this.host.assertCurrent(binding);
    if (this.fault || this.contents.isDestroyed() && !this.retired) throw new VaultBrowserLoginError();
    if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) throw new VaultBrowserLoginError();
  }

  async readCompletion(binding: CredentialUseBinding): Promise<VaultLoginCompletion> {
    this.assertUse(binding, false);
    const documentEpoch = this.documentEpoch();
    const value = await this.call<{ documentId: string; filledPasswordFieldsAbsent: boolean; requiresPersonInteraction: boolean }>('completion');
    this.assertUse(binding, false);
    if (documentEpoch !== this.documentEpoch()) throw new VaultBrowserLoginError();
    if (!value || typeof value.documentId !== 'string' || typeof value.filledPasswordFieldsAbsent !== 'boolean'
      || typeof value.requiresPersonInteraction !== 'boolean') throw new VaultBrowserLoginError();
    return { loginSurfaceId: this.loginSurfaceId, loginSurfaceEpoch: this.loginSurfaceEpoch, surfaceEpoch: this.loginSurfaceEpoch,
      documentId: value.documentId, documentEpoch,
      topDocumentChanged: value.documentId !== binding.documentId, filledPasswordFieldsAbsent: value.filledPasswordFieldsAbsent,
      requiresPersonInteraction: value.requiresPersonInteraction };
  }

  async clearFilledFields(binding: CredentialUseBinding): Promise<{ status: 'cleared' | 'isolated_login_retained' }> {
    try {
      this.assertSurface(binding);
      return { status: await this.call<boolean>('clear') === true ? 'cleared' : 'isolated_login_retained' };
    } catch { return { status: 'isolated_login_retained' }; }
  }

  async destroy(binding: CredentialUseBinding, expectedDocumentEpoch?: string): Promise<{ status: 'destroyed' | 'isolated_login_retained' }> {
    try {
      this.assertSurface(binding);
      if (expectedDocumentEpoch !== undefined && expectedDocumentEpoch !== this.documentEpoch()) return { status: 'isolated_login_retained' };
      return { status: await this.closeOwned() ? 'destroyed' : 'isolated_login_retained' };
    } catch { return { status: 'isolated_login_retained' }; }
  }

  /** No secret has entered this surface yet; failure during setup still has an owned close path. */
  async disposeUnused(): Promise<boolean> {
    if (this.fillAttempted) return false;
    return this.closeOwned();
  }

  private documentEpoch(): string { return `${this.loginSurfaceEpoch}:${this.documentRevision}`; }

  private closeOwned(): Promise<boolean> {
    if (this.contents.isDestroyed()) return Promise.resolve(this.retired);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timeout); resolve(true); };
      const timeout = setTimeout(() => { this.contents.removeListener('destroyed', done); resolve(false); }, 5_000);
      this.contents.once('destroyed', done);
      this.retiring = true;
      try { this.contents.stop(); this.contents.close({ waitForBeforeUnload: false }); }
      catch { clearTimeout(timeout); this.contents.removeListener('destroyed', done); this.fault = true; resolve(false); }
    });
  }

  private assertTarget(requireOriginal = false): void {
    const { host } = this;
    if (remoteBrowserBinding(host.browserId)
      || !browserWebContentsRegistry.isRegistered(host.browserId, host.partition)
      || requireOriginal && (host.agentContents.isDestroyed()
        || browserWebContentsRegistry.browserIdFor(host.agentContents.id) !== host.browserId)) throw new VaultBrowserLoginError();
  }
  private assertLive(): void {
    this.assertTarget();
    if (this.fault || this.contents.isDestroyed() || this.contents.debugger.isAttached()) throw new VaultBrowserLoginError();
  }
  private frameId(): string { return `${this.contents.mainFrame.processId}:${this.contents.mainFrame.routingId}`; }
  private assertSurface(binding: CredentialUseBinding): void {
    if (!this.binding || KEYS.some(key => binding[key] !== this.binding![key])
      || binding.loginSurfaceId !== this.loginSurfaceId || binding.loginSurfaceEpoch !== this.loginSurfaceEpoch) throw new VaultBrowserLoginError();
  }
  private assertUse(binding: CredentialUseBinding, originalDocument: boolean): void {
    this.host.permission.assertCurrent(binding);
    this.assertSurface(binding); this.assertLive(); this.host.assertCurrent(binding);
    if (!this.host.isolationReady()) throw new VaultBrowserLoginError();
    if (binding.browserId !== this.host.browserId || binding.origin !== this.origin || binding.operation !== 'login-submit') throw new VaultBrowserLoginError();
    if (originalDocument && (!this.reviewValue || binding.documentId !== this.reviewValue.documentId
      || binding.formFingerprint !== this.reviewValue.formFingerprint || binding.frameId !== this.frameId())) throw new VaultBrowserLoginError();
    assertCredentialWebsite(this.contents.getURL(), this.origin);
  }
  private async call<T>(method: string, args: unknown[] = []): Promise<T> {
    this.assertLive();
    try {
      return await this.contents.executeJavaScriptInIsolatedWorld(VAULT_LOGIN_WORLD,
        [{ code: `globalThis[${JSON.stringify(VAULT_LOGIN_BRIDGE)}][${JSON.stringify(method)}](...${JSON.stringify(args)})` }]) as T;
    } catch { throw new VaultBrowserLoginError(); }
  }
  private async operation(pending: Pending): Promise<void> {
    if (this.pending) throw new VaultBrowserLoginError();
    this.pending = pending;
    let abort: (() => void) | undefined;
    try {
      const result = await new Promise<boolean>((resolve, reject) => {
        abort = () => reject(new VaultBrowserLoginError());
        pending.lease.signal.addEventListener('abort', abort, { once: true });
        if (pending.lease.signal.aborted) { abort(); return; }
        void this.call<boolean>(pending.phase, [pending.nonce]).then(resolve, () => reject(new VaultBrowserLoginError()));
      });
      if (result !== true) throw new VaultBrowserLoginError();
    } finally {
      if (abort) pending.lease.signal.removeEventListener('abort', abort);
      if (this.pending === pending) this.pending = undefined;
      // This revokes the late IPC gate; it does NOT claim that native work was drained or cleaned.
    }
  }
  private gate(event: IpcMainEvent, input: unknown): void {
    // Electron replies as soon as returnValue is assigned. Never send a provisional denial.
    event.returnValue = this.gateAnswer(event, input);
  }
  private gateAnswer(event: IpcMainEvent, input: unknown) {
    if (input && typeof input === 'object' && (input as VaultLoginGateRequest).phase === 'person-submit') return this.personGate(event, input as VaultLoginGateRequest);
    const pending = this.pending;
    if (!pending || !input || typeof input !== 'object') return { ok: false };
    const request = input as VaultLoginGateRequest;
    if (event.sender !== this.contents || event.senderFrame !== this.contents.mainFrame || !event.senderFrame
      || request.nonce !== pending.nonce || request.phase !== pending.phase
      || request.documentId !== pending.binding.documentId || request.formFingerprint !== pending.binding.formFingerprint
      || request.destination !== this.reviewValue?.destination) return { ok: false };
    this.pending = undefined; // One use even when a subsequent check/side effect fails.
    try {
      this.assertUse(pending.binding, true); pending.lease.signal.throwIfAborted(); pending.lease.assertCurrent();
      pending.lease.signal.throwIfAborted();
      if (pending.phase === 'submit') {
        pending.lease.claimSubmission();
        this.network.arm(request.destination, pending.binding.frameId, () => {
          this.assertUse(pending.binding, true); pending.lease.signal.throwIfAborted(); pending.lease.assertCurrent();
          pending.lease.signal.throwIfAborted();
        });
        return { ok: true };
      } else {
        if (!Buffer.isBuffer(pending.account) || !Buffer.isBuffer(pending.password)) throw new VaultBrowserLoginError();
        return { ok: true, account: pending.account.toString('utf8'), password: pending.password.toString('utf8') };
      }
    } catch { return { ok: false }; }
  }
  private personGate(event: IpcMainEvent, request: VaultLoginGateRequest) {
    const binding = this.binding;
    if (!binding || this.pending || !this.submissionAttempted || event.sender !== this.contents
      || event.senderFrame !== this.contents.mainFrame || !event.senderFrame
      || !/^[a-f0-9]{48}$/.test(request.documentId) || !/^[a-f0-9]{48}$/.test(request.nonce)
      || request.formFingerprint !== request.nonce || request.documentId === binding.documentId
      || this.personDocuments.has(request.documentId) || this.personDocuments.size >= 32) return { ok: false };
    this.personDocuments.add(request.documentId);
    try {
      this.assertUse(binding, false);
      assertCredentialWebsite(request.destination, this.origin);
      const revision = this.documentRevision, frameId = this.frameId();
      this.network.armPerson(request.destination, frameId, () => {
        this.assertUse(binding, false);
        // Native submit starts its own navigation before Chromium asks the request hook.
        if (frameId !== this.frameId() || this.documentRevision !== revision
          && !(this.documentRevision === revision + 1 && this.navigationUrl === request.destination)) throw new VaultBrowserLoginError();
      });
      return { ok: true };
    } catch { return { ok: false }; }
  }
}
