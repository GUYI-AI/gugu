# Read every surface through one replica; say a failed refresh where its value is drawn

Supersedes #2982 (closed). That branch is split three ways: this PR (read paths), device preferences (#3196, merged), and keeping the first frame across restarts (a follow-up PR, built on this one).

## What changes

Each kind of data a surface shows is read through one account- or device-scoped replica (`apps/desktop/src/lib/replica.ts`), never a component's own effect or a second cache. A reading is `unknown`, a `value` (possibly with the error of a failed refresh), or an `error`. Surfaces draw those three states and nothing in between.

The shared layer now does what each caller used to hand-write:

- **Retry on the reading.** Every reading the replica hands out carries `retry`, bound to its own entry. `<RefreshFailed reading={r} />`, `<ReadingSlot>`, `SettingValue` and the version history use it, and a hand-drawn retry button takes `retryOf(reading)`. This removes about 70 per-surface `model.refresh(...args)` retry closures.
- **Refresh by tag.** A model declares `tags`, and `refreshTag(tag, ...args)` reads every model of the tag again. This replaces the hand-written fan-outs `refreshConnections`, `refreshConnectionStatuses`, `marketChanged`, `refreshAutomationRuns` and `refreshSubscriptionReadings`.
- **Change feeds.** A model's `watch` feed runs while a surface shows (or `hold`s) an entry. It is reference-counted by the replica, and a feed that cannot start (an unreachable machine) is logged and skipped. This replaces `watchConnections`' own counter and per-model try/catch around machine events.
- **Write over read.** A read that began before a write (a write's answer, a push) cannot overwrite it. This replaces `cloudComputer`'s `issued/applied` counters.
- **Account scope for stores.** `createSelectStore(initial, { scope: 'account' })` resets on another person signing in or a sign-out, and `patch()` sets or removes one key. Both use the replica's own judgement of an account change (`onAccountChange`). This replaces `followCloudComputerAccount` and `followProgressAccount`, plus the hand-written spread/rest updates.
- **Machine routing at `rpcOn`.** A library host created with the phone's transport registers it once (`routeMachine`), and every reader of that machine follows it.
- **Reads on return.** The app reads push-fed models again once per return to the app (`onReturn`), instead of on every window focus.
- **`ReadingSlot`.** One component draws the three states: placeholder, failure with retry, or value with a failed-refresh line. A placeholder or a failure can be an element (a row skeleton, a failure card).
- **Read now, read once.** `reread(...args)` refreshes and answers in one call; `readOnce(read, { retry })` is a one-off read with the replica's retry policy and no cache, for a preview that reads its bytes once per opening.
- **Writes after an await.** `useEntry(model, args)` binds a write to the account the render drew.
- **One failure log.** A failed read is logged once per entry until it succeeds, by the replica; readers no longer catch, log and rethrow.
- **Source rule.** `scripts/checks/effect-fetch-state.mts` is now a hard rule with no baseline. No component puts a read into its own state. Nothing outside the replica reaches react-query's read hooks or client, and no handler is a hand-written retry (a closure whose only call is `model.refresh(args)`). Exemptions are listed beside the rule (`effect-fetch-state-exemptions.txt`), one line per finding with a category from a closed list and a reason; product code carries no markers.

New read paths that dev gained while #2982 was open go through the same replicas. They are not a second implementation: the marketplace (Agents / Extensions / Connectors), install ranking, version history, per-device install targets, the phone marketplace catalog, custom models, subscription quota per connection, the session permission menu, unavailable local projects (read again on return to the app, instead of their own window focus listener), and the team edition (its own query client is gone: team reads are account replicas, paged lists read a page per entry through `useReplicaPages`).

## Behaviour notes

- A failed refresh that is being retried is not said until its retries are spent, as dev's read recovery (#2882) does. A model whose reads already go through the data client's own retry (postgrest-js, 1 s / 2 s / 4 s) declares no second retry: stacked, the account page said a failed refresh after about 32 s instead of 4 s.
- Reads on return: the push-fed models a surface shows are read again once per return to the app. On dev they were read again only when the page became visible, which switching to another application does not do. Measured cost: the same requests as dev on the usage page; 3–4 more per return elsewhere (plan, agent provisions, cloud computer state), constant per return.
- Global search: a source that failed answers no rows, so a failed search shows no counts (it showed "0" on every tab); the failure line says what happened.
- The market's last-shown shelf still draws the first frame after a restart, through the replica's `local` source.
- Dead code removed: `AppMarketContent`, `AppFeaturedCard` and `app-market-first-screen` were no longer rendered anywhere after the marketplace split; `CloudComputerLoadError` had no caller.
- Settings rows drawn through `SettingValue` now offer "Read again" on every failed read (two of eleven did before): the reading carries its retry.

## Not in this PR

- Keeping the first frame across restarts (bounded `carry`, least-recently-used eviction, the dock and market first screen, featured picture placeholders): a follow-up PR on top of this one.
- `useGroupChatSettings` keeps its own write tracking for reads that start while a write is in flight. Folding it into the replica is a separate change.
- An `unwrapRpc` helper for the repeated `if (!result.success || !result.data) throw` pattern: a separate change.

## Read paths per kind of data

Against dev, per domain: Apps / market 25 kinds, 45 → 25 read paths; agents, connections, team and automations 39 kinds,
52 → 43; assistant panel, cloud computer, devices, phone and settings 43 kinds, 100 → 74; sessions, chat, git, search and
files 26 kinds, 34 → 25. In total 133 kinds, 231 → 167 paths. 17 kinds still have two or more, each for a stated reason.
The main reasons: the market device picker derives readings with per-kind closures; a read that must start after a write
needs a new replica operation; and two MobX stores (projects, session lists) keep their own copies.

## Lines (product code vs tests), against the current dev

Product code (everything outside test files): +11348 −11126, net **+222**. Tests: net +7249. That includes the deletion of
two market panels that were no longer rendered (472 lines). Without them, the net is +694.

## Testing

- Gates (all on the final head): typecheck, `test:unit` (incl. `tests/unit/desktop/mcp`), `session:test:db`, `test:browser`, lint (no cache), `build:renderer:ci`, `lint:source`, permanent-removal and UI-state-debt checks, frozen-file line counts (all unchanged or smaller). One known timing-sensitive test from dev (`agent-home-scan`) fails under full-suite load on dev as well.
- Replica contract tests: write over read, retry bound to its entry, refresh by tag, account-scoped stores.
- Product A/B against the parent build, per surface (run on the head before the read-path round; that round is covered by the gates and the tests of every module it changed): parent build vs this PR, two instances side by side, the same account, every step driven on both at once. Surfaces: task page model menu, marketplace (Agents / Apps / Connectors), installed, an App product page, settings (Account / Usage / Model / Devices), assistant panel, global search.

| cell | result |
|---|---|
| cold start, first frame of each surface | identical on every surface |
| read failure (data API offline, renderer reloaded) and the page's own retry | identical after two fixes in this PR (account page timing, search counts); connectors: same placeholders and notice at 8 s, back 1 s (parent) / 5 s (this PR) after the network returned, which is each one's poll phase |
| away 30 s (window hidden, then shown and focused) and back | identical, no failure said, nothing left stale |
| sign out and sign in as another account | no surface shows the previous account's data, no failure said |
| reads on return (usage page, three returns) | 9 / 9 / 10 requests on both, the same calls |

Re-checked on the final head after the last two changes (retries taken from the reading, the merge of the current dev): settings (Model / Account / Devices / Browser), the App product page with its version history, the marketplace agent detail, the connectors' GitHub detail and the assistant panel; cold start, read failure + retry and away 30 s are identical to the previous head of this PR, with the same request counts on return.

Not measured here: group settings (the test accounts cannot form a group) and the phone's new-task page (needs the phone target).
