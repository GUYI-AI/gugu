# iOS local calendar tools

Refs #1877. This package implements the four existing native calendar payloads. It does not run an agent, request model inference, or replace EventKit with a network service.

`PhoneCalendarService` accepts `calendarList`, `calendarCreate`, `calendarUpdate`, and `calendarDelete`. Arguments and results follow `nativePhoneActions.ts`. The shared calendar catalog resolves model-facing ISO dates and produces native millisecond fields before the native host hashes, journals and approves the request. Extra fields, including a model-supplied `confirmed`, are rejected here as well.

## Host and App integration

The App-target adapter is `../CalendarBridge/GuguCalendarExecutor.swift`. Compile it alongside `Host/GuguHostContracts.swift`; link this package as a local package, or include all files from `Sources/GuguPhoneCalendar` in the App target. Do not compile the same files twice. Engineering project registration belongs to the integration owner.

Construct one `EventKitPhoneCalendarStore`, then a `PhoneCalendarService`, then `GuguCalendarExecutor(service:calendarEnabled:)`. The required `calendarEnabled` closure reads current native owner/installation/category state; it must never derive authorization from request arguments. The host's `checkActive` validates the complete task context and current account/installation before this closure reads the current owner's category selection. Native context and system permissions are checked before data access and after reads; long queries check each enumerated event. The host must call the executor's required `validateAccess(_ control:)` before releasing a saved receipt or protected transcript.

For mutations, the service validates the target, effective dates and recurrence scope before calling `beginMutation`. That hook must durably claim the exact one-use approval. A successful EventKit commit calls `finishMutation` before post-write permission/cancellation checks. If commit or receipt persistence throws, the result is `execution_unknown` and the host must never automatically retry it. The host owns duplicate detection and recovery; there is no second calendar journal. A cancelled call before commit produces no calendar write. Cancellation during a synchronous commit cannot undo the OS write; its known receipt is saved even if protected result delivery is blocked.

The owner connection UI calls `requestAccessFromOwnerUI(checkOwner:completion:)` in the foreground. This entry point is never an agent tool. The owner check must validate the current local owner and explicit connection action before the system prompt and again after its asynchronous response. Add `NSCalendarsFullAccessUsageDescription` for iOS 17+ and `NSCalendarsUsageDescription` for iOS 15–16 to the App's Info.plist. Full access is required for the existing read/write calendar category. Denied, restricted, not-determined and write-only access do not count as connected. No extension, App Group or Associated Domains entitlement is needed.

`../CalendarBridge/GuguCalendarPermissionsPlugin.swift` adapts that entry point for the foreground owner renderer. Register `GuguCalendarPermissionsPlugin(store:checkOwner:)` with the Capacitor bridge; its JS name is `GuguCalendarPermissions`, with only `status()` and `connect()` methods. The required native `checkOwner` closure rejects a stale account/installation or a call outside the current local connection UI. The owner renderer must call `connect()` only for the person's explicit Calendar connection action. Permission discovery calls `status()`, which never prompts. `connect()` returns the actual authorization state; native category consent must still be saved separately for the current owner/installation after full access is granted. Never register these methods as agent tools. This plugin does not expose direct calendar read/write calls that bypass the host.

## Scope

Lists return the caller's requested number of overlapping events (1–500), sorted by native start value. Queries longer than four years are split into one-year EventKit windows so the OS cannot silently shorten the requested range. Boundary duplicates are removed without collapsing recurring occurrences. Missing permission is an error, never a successful empty list. A granted calendar with no events returns an empty list.

Create uses the explicitly requested writable calendar, or the default/first writable calendar if none was requested. An explicitly requested missing or read-only calendar fails. Update changes only supplied fields and validates the effective date range. Delete requires an existing event. Repeating or detached recurrence instances reject with `unsupported_recurrence_scope` before approval consumption and before any write. EventKit's `futureEvents` span is not represented as Android's entire-series behavior.

The native all-day wire format encodes a calendar date at UTC midnight. EventKit uses the same date at the device's local day boundary; conversion preserves dates through timezone offsets and DST. All-day updates receive the shared catalog's ISO-derived instants, like the existing native update contract.

## Targeted tests

The package has no external dependencies. With Swift 6+, `swift test --package-path apps/mobile/ios/PhoneCalendar --disable-xctest --enable-swift-testing` runs pure policy/date tests without opening an event store on macOS. These tests use an injected store. Some Command Line Tools installations keep Testing.framework outside SwiftPM's default search paths; supply that installed framework and macro-plugin search path explicitly when needed, without changing the selected developer directory or installing Xcode. They do not prove EventKit behavior, an iOS app build, permission prompts, a simulator run, or a real iPhone.

## Isolated simulator fixture

`PhoneCalendarSimulatorFixture` exists only in Debug iOS Simulator compilation. It is absent in Release and on physical devices. Use a line-owned simulator signed out of iCloud, with Calendar permission explicitly prepared by the operator; the fixture never requests permission. No test entry point should be exposed in a production tool allowlist.

1. Choose an app-private manifest URL, for example Application Support/CalendarFixture/manifest.json. Call `PhoneCalendarSimulatorFixture.open(manifestURL:)` from the native test harness. Only a local EventKit source is eligible; absence is `unavailable`, not permission to use an account source.
2. The new calendar is titled `Gugu iOS Fixture <runID>`. EventKit supplies its actual `calendarIdentifier`; the returned manifest includes that identifier, exact title and source identifier. Save this actual manifest with the run evidence. Do not invent an identifier before the fixture has run.
3. `makeStore()` restricts every query and mutation to that single calendar. Supplying another calendar ID is rejected. Creating without a calendar ID still writes only to the fixture. Reopening the same manifest validates the same calendar and does not seed again.
4. An independent oracle opens its own EKEventStore and reads only `manifest.calendarIdentifier`, checking title and local source against the manifest first. Seed recurring controls directly into this calendar from the test harness when testing recurrence rejection. The oracle must not request permission or enumerate unrelated calendar data.
5. Call `remove(manifestURL:)` at teardown. It validates the run, identifier, title and local source, and removes only this fixture calendar. Mismatches fail; there is no title-based sweep or deletion of user calendars.

Until an authorized simulator run produces a manifest, the fixture ID and all EventKit outcomes remain unverified. Final iOS evidence must include the same frozen source, App binary, xcresult and raw run logs used by the independent reader.

## App-hosted EventKit acceptance

`IOSHostValidation` includes `DHostedRuntimeTests/testRealEventKitPermissionBoundary`
and `testRealEventKitCRUDRecurrenceAndOwnerRevocation`. Run on a dedicated,
signed-out simulator with the existing HostValidation isolation environment.
Prepare Calendar permission externally and set `GUGU_E6_AUTHORIZATION` to the
expected native authorization string. Run the boundary test first with
`notDetermined`, then `denied`, then `fullAccess`, then revoke and repeat
`denied`, then grant and repeat `fullAccess`. Preserve the isolated home across
these launches: the test verifies that OS revocation retires saved owner
consent and OS reauthorization alone does not restore it.

Run the CRUD test only with full access. It creates a uniquely named local
fixture calendar and deletes that exact calendar in teardown. It checks CRUD
against a fresh independent EventKit reader, preserves an original control
record, reads three daily recurrence occurrences, rejects recurrence update
and delete before consuming approval, rejects recurrence creation arguments,
and verifies that a disconnected original owner cannot mutate the control.
Creating recurrence is not part of the tool contract (`invalid_args` for extra
fields); recurring/detached edits and deletes return
`unsupported_recurrence_scope`. Listing occurrences is supported.

These native tests do not prove the renderer permission page, authenticated
chat-to-calendar delivery, or model execution. Those require separate App UI
acceptance; native authorization assertions must not be reported as UI evidence.

`E6DefaultInstallationTests/testFreshDefaultInstallationSurvivesRepeatedReads`
runs separately after reinstalling the test App. Remove all custom `GUGU_*`
environment entries for this launch. It opens the real App runtime and its
default Application Support installation path, then checks a fresh identity
through repeated reads on the same handle and a new handle. The calendar matrix
continues to select only `DHostedRuntimeTests`, whose isolation setup requires
explicit environment roots. This separate default-path test prevents injected
test roots from hiding installation bootstrap failures.
