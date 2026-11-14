import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { log } from '@main/lib/logger'
import { anySignal } from '@gugu/core/shared/anySignal'
import { passwordGrantLevel, type PasswordApproval, type PasswordExtraValue, type PasswordItem } from '@gugu/core/shared/passwordBetaProtocol'
import type { GuguMcpContext } from '../acp-engine-utils'
import { passwordNativeMcpIdentity } from '../mcp/password-native-identity'
import type { createBetaPasswordAccess } from '../permissions/password-beta-access'
import { browserWebContentsRegistry as browsers } from '../session/main/core/browser/browser-webcontents-registry'
import { credentialBindingMatches } from '../session/main/core/browser/credential-binding'
import { createCredentialExecution } from '../session/main/core/browser/credential-execution'
import { AgentPageFill, type AgentPageReview } from '../session/main/core/browser/vault-agent-page-fill'
import type { CredentialUseBinding } from '../session/main/core/browser/credential-use-contract'
import type { UseOutcomeContext, PostUseAuditResult } from '../session/main/core/browser/credential-settlement-contract'
import type { LocalPasswordVault } from './service'
import type { VaultBrowserSink, VaultFillPlan, VaultFillValue } from './contracts'
import { postPasswordRequest } from './beta-messages'
import { credentialWebsiteOrigin } from '../session/main/core/browser/credential-website'
import { invalid, resolveFill, type FillInvalid, type FillRequest, type FillSource } from './fill-plan'
export type { FillEntry, FillInvalid, FillRequest } from './fill-plan'

/** How the card names a value for the person's own lookups: `account`, `password`, or the field's id. */
const keyOf = (value: VaultFillValue, index: number) => value.kind === 'account' || value.kind === 'password' ? value.kind : value.kind === 'typed' ? `typed:${index}` : value.id
const unavailable = () => new Error('password_login_unavailable')
type Execution = ReturnType<typeof createCredentialExecution>
/** 「记住」 after a fill: waiting for the login to go through, kept, or dropped (it did not). */
export type FillKeep = 'waiting' | 'kept' | 'dropped'
type Attempt = { binding: CredentialUseBinding; execution: Execution; running?: Promise<void>; view: PasswordApproval; result: string; plan: VaultFillPlan
  /** The Agent's own tab, its inputs (CSS selectors, in the order of the values) and what the review found there. */
  contents: WebContents; page: AgentPageFill; fills: string[]; review: AgentPageReview
  /** A password input among the targets: a login, which went through when the page no longer asks for a password. */
  login: boolean
  /** Who 「始终允许」 lets use it without asking (the caller's Agent), when that may be given. */
  subject?: string
  /**
   * The person's yes beyond this use. With values not in the vault yet (typed or given), 「存到咕咕」: keep them, once
   * they went through, allowing nobody. With everything saved, 「始终允许」: allow `subject` on this website.
   */
  remember?: { values: (string | undefined)[]; secret?: readonly boolean[]; extra?: PasswordExtraValue[] }
  keep?: FillKeep
  /** Where each value comes from, its name, and whether it is secret: what 「记住」 writes. */
  sources: FillSource[]; names: string[]; secret: boolean[]
  evidence?: UseOutcomeContext & { postUseAudit: PostUseAuditResult }; completed: boolean }
/** How long a login may take after the fill (the Agent still has to press the button) before 「记住」 gives up. */
const LOGIN_WATCH_MS = 5 * 60_000
/** A page without a password input this many checks in a row (one a second): the login went through. */
const LOGIN_SETTLED_CHECKS = 2

export interface BetaLoginHost {
  ownerId: string; deviceId: string; signal: AbortSignal
  access: ReturnType<typeof createBetaPasswordAccess>
  assertCurrent(): void
  changed(): void
  describe(agentId: string, sessionId: string): { agentName: string; sessionTitle: string }
  /** Grant subjects that identify the caller (its Agent, its project). */
  subjects(agentId: string, sessionId: string): string[]
  denied(): boolean
  deliver(sessionId: string, requestId: string, status: string): Promise<void>
  /**
   * The person's 「记住」 (a person's edit, once the values went through): the values typed on the card go into the
   * credential (a new one when there was none), `origin` becomes one of its sites, and `subject`, if given, may use it
   * without asking.
   */
  remember(input: { credentialId?: string; origin: string; subject?: string; values: { key: string; name: string; secret: boolean; value: string }[] }): Promise<void>
}

/**
 * password_fill in the browser: the values go into the inputs of the Agent's own tab, like a person's autofill, and
 * nothing more. The Agent presses the button and reads the result itself. Approval, capability and audit remain owned
 * by the existing execution authority and the vault.
 */
export class BetaPasswordLogin {
  private readonly attempts = new Map<string, Attempt>()
  private preparing = false
  private vault?: LocalPasswordVault
  constructor(private readonly host: BetaLoginHost) {}
  bindVault(vault: LocalPasswordVault): void { if (this.vault) throw unavailable(); this.vault = vault }
  readonly sink: VaultBrowserSink = Object.freeze<VaultBrowserSink>({
    claimCredentialSink: (cap, binding) => this.require(binding).execution.authority.claimCredentialSink(cap, binding),
    fillAndSubmit: async (binding, secrets, control) => {
      const use = this.require(binding)
      control.assertCurrent()
      if (!await use.page.fill(use.review, use.fills, secrets.values)) return 'failed'
      control.assertCurrent()
      use.completed = true
      return 'filled'
    },
    cleanup: async useId => {
      const use = [...this.attempts.values()].find(item => item.binding.useId === useId)
      if (use) await use.execution.authority.cleanup(useId)
      // Nothing private to clean: the values are in the Agent's page, as the person approved.
      return { status: 'isolated_login_retained' }
    },
    settle: async event => { this.require(event.binding).evidence = event },
  })
  /** Where each card's use is, for the person's own card: approved, running, then its result and what 「记住」 did. */
  outcomes(): { requestId: string; result: string; keep?: FillKeep }[] {
    return [...this.attempts.values()].filter(use => use.result !== 'pending')
      .map(use => ({ requestId: use.binding.requestId, result: use.result, ...(use.keep ? { keep: use.keep } : {}) }))
  }
  pending(): PasswordApproval[] {
    return [...this.attempts.values()].filter(use => use.result === 'pending' && use.execution.status().status === 'pending').map(use => use.view)
  }
  status(requestId: string, sessionId: string): string {
    const use = this.attempts.get(requestId)
    if (!use || use.binding.sessionId !== sessionId) throw unavailable()
    return use.result
  }
  async request(context: GuguMcpContext, grant: AbortSignal, item: PasswordItem | undefined, input: FillRequest): Promise<{ requestId: string; status: string } | FillInvalid> {
    const resolved = resolveFill(item, input.fill)
    if ('status' in resolved) return resolved
    let origin: string
    try { origin = credentialWebsiteOrigin(input.url) } catch { return invalid('url must be the https page that has these inputs.') }
    const fills = input.fill.map(entry => entry.into)
    // Its own website and its sites are where it belongs; anywhere else only with the person's approval of this use.
    const elsewhere = !!item && origin !== item.origin && !item.sites.includes(origin)
    if (!this.vault || this.preparing || this.host.denied()
      || [...this.attempts.values()].some(use => ['pending', 'running'].includes(use.result))) throw unavailable()
    this.preparing = true
    let registered: Attempt | undefined
    try {
      const identity = passwordNativeMcpIdentity(context)
      if (!identity || identity.ownerId !== this.host.ownerId) throw unavailable()
      const signal = anySignal([grant, this.host.signal])
      const assertCurrent = () => { signal.throwIfAborted(); this.host.assertCurrent(); if (this.host.denied()) throw unavailable() }
      assertCurrent()
      // The Agent's browser tools do not name their tabs, so without an id this is the task's tab showing the website
      // (most recently viewed first).
      const pages = browsers.browsersOfSession(identity.sessionId)
      const browserId = input.browserId ?? pages.find(page => { try { return new URL(page.webContents.getURL()).origin === origin } catch { return false } })?.browserId
      const source = pages.find(page => page.browserId === browserId)?.webContents
      const partition = browserId ? [...browsers.registeredPartitions].find(value => browsers.isRegisteredForSession(browserId, identity.sessionId, value)) : undefined
      if (!browserId || !source || !partition) return invalid('Open the page in your browser first: no tab of this task shows that website.')
      const page = new AgentPageFill(source, origin)
      let review: AgentPageReview
      try { review = await page.review(fills) }
      catch { return invalid('Each into must match exactly one visible, editable text input on the page your tab shows now.') }
      const installation = await this.vault.prepareInstallationIdentity()
      assertCurrent(); installation.assertCurrent()
      if (installation.value.status !== 'persisted') throw unavailable()
      // eslint-disable-next-line prefer-const -- callbacks read these before the preparation finishes.
      let binding: CredentialUseBinding | undefined, attempt: Attempt | undefined
      const native = { context, sessionId: identity.sessionId, installationId: installation.value.installationId,
        deviceId: this.host.deviceId, signal, assertCurrent }
      // eslint-disable-next-line prefer-const -- the permission getter exists before the target is built.
      let target: Omit<CredentialUseBinding, 'requestId' | 'useId'> | undefined
      const port = await this.host.access.createPermission(native, () => binding ?? target!)
      assertCurrent()
      const execution = createCredentialExecution({
        current: () => { assertCurrent(); return true },
        // The values go into the Agent's own page: there is no private copy to keep apart.
        isolationCurrent: () => true,
        verifyLocalDecision: (_current, evidence) => evidence === this,
        registerUse: () => {},
        cleanup: async () => ({ status: 'isolated_login_retained' }),
        useCredential: (capability, current) => {
          if (!attempt || !this.vault) throw unavailable()
          return this.vault.useCredential(capability, current, attempt.plan)
        },
      }, port, signal)
      // A secret value in an ordinary input can be shown again by the page: the person sees that on the card.
      const exposed = resolved.names.filter((_name, index) => resolved.secret[index] && !review.passwordInputs[index])
      target = { loginSurfaceId: randomUUID(), loginSurfaceEpoch: randomUUID(), documentId: review.documentId, frameId: review.frameId,
        formFingerprint: randomUUID(), origin, accountId: identity.ownerId, installationId: installation.value.installationId,
        agentId: identity.subjectId, sessionId: identity.sessionId, browserId,
        // Nothing saved for the website: a use of values typed for it alone, bound to no stored credential.
        credentialId: item?.reference.id ?? `typed:${randomUUID()}`, credentialVersion: String(item?.reference.version ?? 0), lockEpoch: item?.reference.epoch ?? this.vault.state().epoch,
        operation: 'login-submit' }
      const presentation = this.host.describe(identity.subjectId, identity.sessionId)
      const subjects = this.host.subjects(identity.subjectId, identity.sessionId)
      assertCurrent()
      const view = await execution.request(target, randomUUID())
      binding = Object.freeze({ ...target, requestId: view.requestId, useId: view.useId })
      const missing = resolved.sources.includes('missing')
      // An Agent already allowed on the credential is not asked, on its own websites and into inputs that keep a secret
      // hidden, when nothing is missing. Everyone else, and anything else, sees the card.
      const granted = !!item && !!passwordGrantLevel(item.grants, subjects) && !elsewhere && !exposed.length && !missing
      // 「记住」 has something to do when a value is typed or given, or when the Agent may be allowed for next time.
      const keeps = resolved.sources.some(value => value !== 'saved')
      const remember = !subjects.length ? (keeps ? 'keep' : undefined) : exposed.length ? (keeps ? 'keep' : undefined) : 'auto'
      attempt = { binding, execution, contents: source, page, fills, review, completed: false, result: 'pending', login: review.passwordInputs.some(Boolean),
        ...(subjects.length && !exposed.length ? { subject: subjects[0] } : {}), sources: resolved.sources, names: resolved.names, secret: resolved.secret,
        plan: Object.freeze({ values: Object.freeze(resolved.values), elsewhere, typed: Object.freeze([...resolved.given]), ...(item ? {} : { transient: true }) }), view: {
        requestId: view.requestId, origin, agent: identity.subjectId, ...presentation, sessionId: identity.sessionId,
        deviceId: this.host.deviceId, maskedAccount: item?.maskedAccount ?? '', expiresAt: view.requestExpiresAt, fields: resolved.names,
        ...(item ? { credentialId: item.reference.id } : {}), ...(item && origin !== item.origin ? { credential: item.name || new URL(item.origin).hostname } : {}),
        ...(elsewhere ? { elsewhere: true } : {}), ...(exposed.length ? { exposed } : {}),
        fills: resolved.names.map((value, index) => ({ value, key: keyOf(resolved.values[index]!, index), input: review.labels[index]!, source: resolved.sources[index]!,
          ...(resolved.given[index] !== undefined ? { given: resolved.given[index] } : {}), ...(resolved.secret[index] ? { secret: true } : {}),
          ...(resolved.secret[index] && !review.passwordInputs[index] ? { plain: true } : {}) })), ...(remember ? { remember } : {}) } }
      this.attempts.set(view.requestId, attempt)
      registered = attempt
      if (!granted) await postPasswordRequest(context, attempt.view)
      assertCurrent()
      const expired = setTimeout(() => {
        if (attempt?.execution.status().status === 'expired') {
          attempt.result = 'expired'; this.forget(attempt)
          void this.host.deliver(identity.sessionId, view.requestId, 'expired').catch(() => {})
          this.host.changed()
        }
      }, Math.max(1, view.requestExpiresAt - Date.now() + 1))
      expired.unref?.()
      signal.addEventListener('abort', () => { try { execution.cancel() } catch { /* Already decided or used. */ } }, { once: true })
      if (granted) {
        // Already allowed: filled right away, and the Agent reads the result from this call.
        this.conclude(attempt, 'allow_once', false)
        await attempt.running
        return { requestId: view.requestId, status: attempt.result }
      }
      this.host.changed()
      return { requestId: view.requestId, status: 'pending' }
    } catch {
      // A notification may have committed before its response was lost. Its old card must never approve.
      if (registered && registered.result === 'pending') {
        try { registered.execution.cancel() } catch { /* Original authority may already be invalidated. */ }
        registered.result = 'cancelled'
        this.attempts.delete(registered.binding.requestId)
        this.host.changed()
      }
      throw unavailable()
    }
    finally { this.preparing = false }
  }
  /**
   * The person's answer on the card. `typed`: what they typed, by position (blank: the saved or given value); a missing
   * value must be typed. `remember`: keep what was typed (and allow the Agent next time, when the card offers that).
   * 「填入」 fills the Agent's page at once; the Agent hears the result.
   */
  decide(requestId: string, decision: 'allow_once' | 'reject', typed?: readonly string[], remember?: boolean, secret?: readonly boolean[], extra?: readonly PasswordExtraValue[]): void {
    const use = this.attempts.get(requestId)
    if (!use || !['allow_once', 'reject'].includes(decision)) throw unavailable()
    if (typed !== undefined && (!Array.isArray(typed) || typed.length > use.plan.values.length || typed.some(text => typeof text !== 'string' || text.length > 4096))) throw unavailable()
    if (secret !== undefined && (!Array.isArray(secret) || secret.length !== use.plan.values.length || secret.some(flag => typeof flag !== 'boolean'))) throw unavailable()
    if (extra !== undefined && (!Array.isArray(extra) || extra.length > 16 || extra.some(entry => !entry || typeof entry.name !== 'string' || !entry.name.trim()
      || entry.name.length > 200 || typeof entry.value !== 'string' || !entry.value || entry.value.length > 65536 || typeof entry.secret !== 'boolean'))) throw unavailable()
    if (decision !== 'reject') {
      const values = use.plan.values.map((_value, index) => typed?.[index] || use.plan.typed?.[index] || undefined)
      if (use.sources.some((source, index) => source === 'missing' && !values[index])) throw unavailable()
      use.plan = Object.freeze({ ...use.plan, typed: Object.freeze([...values]) })
      // Its own copy: the plan's is frozen, and this one is cleared once 「记住」 is done with it.
      if (remember && use.view.remember) use.remember = { values: [...values], ...(secret ? { secret: [...secret] } : {}),
        ...(extra?.length && this.storing(use) ? { extra: extra.map(entry => ({ name: entry.name.trim(), value: entry.value, secret: entry.secret })) } : {}) }
    }
    this.conclude(use, decision, true)
  }
  /** The person's decision, or a standing grant on the credential. An approval fills right away. */
  private conclude(use: Attempt, decision: 'allow_once' | 'reject', deliver: boolean): void {
    const requestId = use.binding.requestId
    if (use.execution.status().status !== 'pending') throw unavailable()
    const view = use.execution.decide(decision, this)
    if (view.status === 'approved') {
      use.result = 'approved'
      use.running = this.run(use).then(() => {
        if (deliver) void this.host.deliver(use.binding.sessionId, requestId, use.result).catch(() => {})
      })
    } else {
      use.result = view.status
      this.forget(use)
      if (deliver) void this.host.deliver(use.binding.sessionId, requestId, view.status).catch(() => {})
    }
    this.host.changed()
  }
  /** Kept for Agents that still call it after an approval: the fill already happened, this reads its result. */
  async start(context: GuguMcpContext, requestId: string): Promise<{ status: string }> {
    const identity = passwordNativeMcpIdentity(context), use = this.attempts.get(requestId)
    if (!identity || !use || identity.sessionId !== use.binding.sessionId || identity.subjectId !== use.binding.agentId
      || identity.ownerId !== use.binding.accountId || !use.running) throw unavailable()
    await use.running
    return { status: use.result }
  }
  invalidate(): void {
    for (const use of this.attempts.values()) {
      use.execution.authority.invalidate(this.host.ownerId, 'lock')
      this.forget(use)
      if (['pending', 'approved', 'running'].includes(use.result)) {
        use.result = 'invalidated'
        void this.host.deliver(use.binding.sessionId, use.binding.requestId, 'invalidated').catch(() => {})
      }
    }
    this.host.changed()
  }
  /** 「记住」 for values that did not go through: drop what was typed. */
  private forget(use: Attempt): void {
    if (use.remember && use.keep === 'waiting') use.keep = 'dropped'
    use.remember?.values.fill(undefined); for (const entry of use.remember?.extra ?? []) entry.value = ''; use.remember = undefined
  }
  /** Values on the card that are not in the vault yet: 「存到咕咕」 keeps them; otherwise the yes is 「始终允许」. */
  private storing(use: Attempt): boolean { return use.sources.some(source => source !== 'saved') }
  /** After the values went through: changing the credential earlier would end the use it was approved with. */
  private rememberSite(use: Attempt): void {
    const kept = use.remember
    if (!kept) return
    use.remember = undefined
    // Keeping is not allowing: a kept value is asked for again; only 「始终允许」 on a saved one allows the Agent.
    const storing = this.storing(use)
    // A password is always 保密; anything else as the person marked it on the card.
    const values = !storing ? [] : [...use.sources.map((source, index) => ({ key: keyOf(use.plan.values[index]!, index), name: use.names[index]!,
      secret: use.names[index] === '密码' || (kept.secret?.[index] ?? use.secret[index]!), value: kept.values[index] ?? '' }))
      .filter((entry, index) => use.sources[index] !== 'saved' || entry.value),
      ...(kept.extra ?? []).map((entry, index) => ({ key: `extra:${index}`, name: entry.name, secret: entry.secret, value: entry.value }))]
    const subject = !storing && use.view.remember === 'auto' ? use.subject : undefined
    if (!storing && !subject) { kept.values.fill(undefined); return }
    const clear = () => { kept.values.fill(undefined); for (const entry of kept.extra ?? []) entry.value = '' }
    void this.host.remember({ ...(use.view.credentialId ? { credentialId: use.view.credentialId } : {}), origin: use.binding.origin, ...(subject ? { subject } : {}), values })
      .then(() => { use.keep = 'kept'; this.host.changed() }, () => { use.keep = 'dropped'; this.host.changed() })
    clear()
  }
  /**
   * A login is kept once it went through: the Agent presses the button, and the page (the same one or the next) no
   * longer asks for a password. A new page that asks again (a wrong password, mostly) keeps nothing.
   */
  private watchLogin(use: Attempt): void {
    use.keep = 'waiting'
    const started = Date.now()
    let navigated = false, settled = 0, checking = false
    const onNavigate = () => { navigated = true; settled = 0 }
    use.contents.on('did-navigate', onNavigate)
    const done = (went: boolean) => {
      clearInterval(timer)
      if (!use.contents.isDestroyed()) use.contents.off('did-navigate', onNavigate)
      if (went) this.rememberSite(use); else this.forget(use)
      this.host.changed()
    }
    const timer = setInterval(() => {
      if (checking) return
      if (!use.remember) return done(false)
      if (use.contents.isDestroyed() || Date.now() - started > LOGIN_WATCH_MS) return done(false)
      if (use.contents.isLoading()) return
      checking = true
      void use.page.passwordPresent().then(state => {
        checking = false
        if (!state || !use.remember) return
        if (!state.passwordPresent) { if (++settled >= LOGIN_SETTLED_CHECKS) done(true); return }
        settled = 0
        // A newly loaded page that asks for the password again: the site sent the login back.
        if (navigated && state.documentId !== use.review.documentId) done(false)
      }, () => { checking = false })
    }, 1000)
    timer.unref?.()
  }
  private require(binding: CredentialUseBinding): Attempt {
    const use = this.attempts.get(binding.requestId)
    if (!use || !credentialBindingMatches(use.binding, binding)) throw unavailable()
    return use
  }
  private current(use: Attempt): void { this.host.signal.throwIfAborted(); this.host.assertCurrent(); use.execution.permission.assertCurrent(use.binding) }
  private async run(use: Attempt): Promise<void> {
    use.result = 'running'
    this.host.changed()
    let outcome: string | undefined
    try {
      this.current(use)
      const result = await use.execution.use()
      outcome = result.status
      const evidence = use.evidence
      if (result.status !== 'filled' || !use.completed || !evidence || evidence.postUseAudit.status !== 'recorded'
        || !this.vault?.outcomeAudit.matches(evidence.postUseAudit, evidence)) throw unavailable()
      use.result = 'filled'
    } catch (error) {
      // Names and statuses only, never a value.
      log.warn('Password fill: the values did not go in', { requestId: use.binding.requestId, outcome, completed: use.completed,
        postUseAudit: use.evidence?.postUseAudit.status, error: error instanceof Error ? (error as { code?: string }).code ?? error.message.slice(0, 80) : 'unknown' })
      use.result = 'unavailable'
    } finally {
      // 「存到咕咕」: a login once it went through; anything else (an API key into a settings page) once filled.
      // 「始终允许」 on saved values: at once.
      try {
        if (use.result !== 'filled' || !use.remember) this.forget(use)
        else if (use.login && this.storing(use)) this.watchLogin(use)
        else this.rememberSite(use)
      } catch (error) { log.warn('Password fill: 记住 failed', { requestId: use.binding.requestId, error: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }) }
      this.host.changed()
    }
  }
}
