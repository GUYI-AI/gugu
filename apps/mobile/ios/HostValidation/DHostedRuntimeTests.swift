#if DEBUG && os(iOS) && targetEnvironment(simulator)
import XCTest
import Darwin
import EventKit
import CryptoKit
@testable import App
#if canImport(GuguPhoneCalendar)
import GuguPhoneCalendar
#endif

private final class DLocked<Value> {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    @discardableResult func access<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

private final class DCalendarPermissionStore: PhoneCalendarStore {
    var authorization: PhoneCalendarAuthorization = .denied
    let timezone = TimeZone(secondsFromGMT: 0)!
    func read(start: Int64, end: Int64, limit: Int, checkpoint: @escaping () throws -> Void) throws -> [PhoneCalendarEvent] {
        XCTFail("Receipt validation must not read calendar events")
        throw PhoneCalendarFailure("D_unexpected_read", "D permission fixture")
    }
    func prepare(_ command: PhoneCalendarCommand) throws -> PhoneCalendarPreparedWrite {
        XCTFail("Receipt validation must not prepare a calendar write")
        throw PhoneCalendarFailure("D_unexpected_write", "D permission fixture")
    }
}

/// App-hosted unit tests. Neither this file nor the oracle belongs in App Sources.
/// The runtime and calendar executor are imported from the actual App module.
final class DHostedRuntimeTests: XCTestCase {
    private func attach(_ name: String, _ value: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // Read-only launch input checks; only the parent prepares stable Simulator roots.
    override func setUpWithError() throws {
        try super.setUpWithError()
        let environment = ProcessInfo.processInfo.environment
        guard Bundle.main.bundleIdentifier == "app.gugu.chat",
              let expectedUDID = environment["GUGU_D_EXPECTED_SIMULATOR_UDID"],
              UUID(uuidString: expectedUDID) != nil,
              environment["SIMULATOR_UDID"]?.lowercased() == expectedUDID.lowercased(),
              let isolationID = environment["GUGU_D_ISOLATION_UUID"],
              UUID(uuidString: isolationID)?.uuidString.lowercased() == isolationID else {
            throw GuguHostFailure(code: "D_wrong_test_host", message: "TestHost differs from the owned Simulator launch input")
        }
        let container = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .resolvingSymlinksInPath().standardizedFileURL
        let dataRoot = container.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let appParent = dataRoot.appendingPathComponent("Containers/Data/Application", isDirectory: true)
        guard dataRoot.lastPathComponent == "data",
              dataRoot.deletingLastPathComponent().lastPathComponent.lowercased() == expectedUDID.lowercased(),
              container.deletingLastPathComponent().path == appParent.path,
              UUID(uuidString: container.lastPathComponent) != nil else {
            throw GuguHostFailure(code: "D_wrong_container", message: "Actual App container escapes the owned Simulator")
        }
        let stable = dataRoot.appendingPathComponent("GuguDIsolated", isDirectory: true)
            .appendingPathComponent(isolationID, isDirectory: true).standardizedFileURL
        guard environment["GUGU_D_EXPECTED_STABLE_ROOT"] == stable.path,
              stable.resolvingSymlinksInPath().path == stable.path,
              let expectedMarkerSHA = environment["GUGU_D_ROOT_MARKER_SHA256"] else {
            throw GuguHostFailure(code: "D_wrong_stable_root", message: "Stable root launch identity is missing")
        }
        var roots: [String: Any] = [:], cRoots: [String: Any] = [:], accessChecks: [String: Bool] = [:]
        for (key, leaf) in [("GUGU_HOME", "home"), ("GUGU_USER_DATA_DIR", "user-data")] {
            let expected = stable.appendingPathComponent(leaf, isDirectory: true)
            guard let raw = environment[key], raw == expected.path,
                  expected.resolvingSymlinksInPath().path == raw,
                  let cValue = getenv(key), String(cString: cValue) == raw else {
                throw GuguHostFailure(code: "D_stale_data_root", message: "Process environment differs from the owned stable root")
            }
            let attributes = try FileManager.default.attributesOfItem(atPath: raw)
            guard attributes[.type] as? FileAttributeType == .typeDirectory,
                  (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                  access(raw, R_OK | W_OK | X_OK) == 0 else {
                throw GuguHostFailure(code: "D_invalid_data_root", message: "Root is not owned, private, readable and writable")
            }
            let bytes = try Data(contentsOf: expected.appendingPathComponent(".d-root-owner.json"))
            let markerSHA = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let marker = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: String])
            guard markerSHA == expectedMarkerSHA, marker["ownedUDID"] == expectedUDID,
                  marker["isolationUUID"] == isolationID else {
                throw GuguHostFailure(code: "D_wrong_root_marker", message: "Prelaunch root marker differs from launch custody")
            }
            roots[key] = raw; cRoots[key] = String(cString: cValue); accessChecks[key] = true
        }
        let support = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
            .resolvingSymlinksInPath().standardizedFileURL
        guard support.path.hasPrefix(container.path + "/") else {
            throw GuguHostFailure(code: "D_wrong_support_root", message: "ApplicationSupport escapes the current App container")
        }
        try attach("D-App-prelaunch-root-readback", ["phase": "read-only-before-test-body",
            "bundleId": Bundle.main.bundleIdentifier ?? "", "pid": ProcessInfo.processInfo.processIdentifier,
            "expectedSimulatorUDID": expectedUDID, "observedSimulatorUDID": environment["SIMULATOR_UDID"] ?? "",
            "currentContainer": container.path, "roots": roots, "cEnvironmentRoots": cRoots,
            "stableRoot": stable.path, "isolationUUID": isolationID, "markerSHA256": expectedMarkerSHA,
            "markerReadVerified": true, "writeAccessChecked": true, "writeExercisePerformed": false,
            "readWriteSearchAccess": accessChecks, "privateDirectoryUID": getuid(),
            "nativeApplicationSupport": support.path,
            "environmentMutationPerformed": false, "rootCreationPerformed": false])
    }

    private func asset() throws -> (Data, String) {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "app.gugu.chat", "Actual App must be TestHost")
        let assetURL = try XCTUnwrap(Bundle.main.url(forResource: "agent", withExtension: "js", subdirectory: "HostRuntime"))
        let manifestURL = try XCTUnwrap(Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "HostRuntime"))
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as? [String: Any])
        let expected = try XCTUnwrap(ProcessInfo.processInfo.environment["GUGU_D_EXPECTED_ASSET_SHA256"],
                                    "Set from independently frozen resource bytes before execution")
        XCTAssertNotNil(expected.range(of: "^[0-9a-f]{64}$", options: .regularExpression))
        let bytes = try Data(contentsOf: assetURL)
        let observed = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(observed, expected)
        XCTAssertEqual(manifest["sha256"] as? String, expected)
        XCTAssertEqual((manifest["bytes"] as? NSNumber)?.intValue, bytes.count)
        let noticesURL = try XCTUnwrap(Bundle.main.url(forResource: "npm-packages", withExtension: "json", subdirectory: "HostRuntime/licenses"))
        let notices = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: noticesURL)) as? [[String: Any]])
        XCTAssertFalse(notices.isEmpty, "Dependency license index must be inside the App")
        for notice in notices {
            let files = try XCTUnwrap(notice["files"] as? [String])
            XCTAssertFalse(files.isEmpty)
            for file in files {
                guard !file.hasPrefix("/"), !file.split(separator: "/").contains("..") else {
                    throw GuguHostFailure(code: "invalid_license_path", message: "License index escapes resource directory")
                }
                let license = noticesURL.deletingLastPathComponent().appendingPathComponent(file)
                XCTAssertFalse(try Data(contentsOf: license).isEmpty, "Missing license body")
            }
        }
        try attach("D-App-bundled-resource", ["bundleId": Bundle.main.bundleIdentifier ?? "",
            "appExecutable": Bundle.main.executableURL?.lastPathComponent ?? "",
            "assetSHA256": observed, "assetBytes": bytes.count,
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") ?? NSNull(), "licensePackages": notices.count,
            "productionTaskEntryVerified": false])
        return (bytes, expected)
    }

    private func context() -> GuguHostContext {
        GuguHostContext(ownerId: UUID().uuidString, installationId: UUID().uuidString,
            agentUserId: UUID().uuidString, sessionId: UUID().uuidString, jobId: UUID().uuidString,
            contextEpoch: UUID().uuidString, runtimeInstanceId: UUID().uuidString)
    }

    private func jsonContext(_ binding: GuguHostContext) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(binding)) as? [String: Any])
    }

    func testPackagedResourceAndProcessDiagnosticsInActualAppHost() throws {
        let (bytes, hash) = try asset()
        let unexpected = DLocked<[String]>([])
        let runtime = try GuguJavaScriptRuntime(asset: bytes, expectedSHA256: hash,
            request: { request, reply in
                unexpected.access { $0.append(request.method) }
                reply(["ok": false, "code": "D_unexpected_request", "message": "Diagnostics must not run tools/models"])
            }, cancel: { _ in }, event: { event in
                if event["type"] as? String == "host_error" { unexpected.access { $0.append("host_error") } }
            })
        let diagnostics = try runtime.diagnostics()
        XCTAssertEqual(diagnostics["bundleId"] as? String, "app.gugu.chat")
        XCTAssertEqual((diagnostics["pid"] as? NSNumber)?.int64Value, Int64(ProcessInfo.processInfo.processIdentifier))
        XCTAssertEqual(diagnostics["assetSHA256"] as? String, hash)
        XCTAssertEqual(diagnostics["engine"] as? String, "JavaScriptCore")
        XCTAssertEqual(diagnostics["node"] as? Bool, false)
        XCTAssertTrue(unexpected.access { $0.isEmpty })
        try attach("D-App-runtime-diagnostics", diagnostics)
    }

    func testDeterministicPiToSwiftRoundTripInActualAppHost() throws {
        let (bytes, hash) = try asset()
        let binding = context()
        let trustedContext = try jsonContext(binding)
        let done = expectation(description: "Deterministic Pi turn finished")
        done.assertForOverFulfill = true
        struct Observation {
            var models = 0
            var tools: [[String: Any]] = []
            var journals = 0
            var result: [String: Any]?
            var errors: [String] = []
        }
        let observed = DLocked(Observation())
        let runtime = try GuguJavaScriptRuntime(asset: bytes, expectedSHA256: hash,
            request: { request, reply in
                switch request.method {
                case "model.complete":
                    let count = observed.access { $0.models += 1; return $0.models }
                    let message: [String: Any] = count == 1
                        ? ["role": "assistant", "content": NSNull(), "tool_calls": [["id": "D-hosted-calendar-1", "type": "function",
                            "function": ["name": "phone_calendar_list", "arguments": "{\"date\":\"2026-11-08\"}"]]]]
                        : ["role": "assistant", "content": "D deterministic hosted round trip"]
                    reply(["ok": true, "data": ["choices": [["finish_reason": count == 1 ? "tool_calls" : "stop", "message": message]]]])
                case "tool.execute":
                    observed.access { $0.tools.append(request.payload) }
                    reply(["ok": true, "data": ["ok": true, "data": ["events": [], "timezone": TimeZone.current.identifier,
                        "D_fixture_only": true]]])
                case "journal.event":
                    observed.access { $0.journals += 1 }
                    reply(["ok": true, "data": [:]])
                case "turn.finished":
                    observed.access { $0.result = request.payload }
                    reply(["ok": true, "data": [:]])
                    done.fulfill()
                default:
                    observed.access { $0.errors.append(request.method) }
                    reply(["ok": false, "code": "D_unexpected_method", "message": request.method])
                }
            }, cancel: { _ in }, event: { event in
                if event["type"] as? String == "host_error" {
                    observed.access { $0.errors.append(event["message"] as? String ?? "host_error") }
                    done.fulfill()
                }
            })
        try runtime.start(["context": trustedContext, "modelId": "D-fixture-no-network", "systemPrompt": "D deterministic fixture",
            "prompt": "Exercise a local native callback", "tools": [["name": "phone_calendar_list", "actionName": "calendar.events.list"]]])
        wait(for: [done], timeout: 15)
        let snapshot = observed.access { $0 }
        XCTAssertTrue(snapshot.errors.isEmpty)
        XCTAssertEqual(snapshot.models, 2)
        XCTAssertEqual(snapshot.tools.count, 1)
        XCTAssertGreaterThan(snapshot.journals, 0)
        XCTAssertEqual(snapshot.result?["status"] as? String, "done")
        XCTAssertEqual(snapshot.result?["text"] as? String, "D deterministic hosted round trip")
        let tool = try XCTUnwrap(snapshot.tools.first)
        XCTAssertEqual(tool["actionName"] as? String, "calendar.events.list")
        let passedContext = try XCTUnwrap(tool["context"] as? [String: Any])
        XCTAssertEqual(NSDictionary(dictionary: passedContext), NSDictionary(dictionary: trustedContext))
        let args = try XCTUnwrap(tool["args"] as? [String: Any])
        XCTAssertNil(args["date"], "Shared calendar catalog must project before native dispatch")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        let start = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 8)))
        let end = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: start))
        XCTAssertEqual((args["start_ms"] as? NSNumber)?.int64Value, Int64(start.timeIntervalSince1970 * 1_000))
        XCTAssertEqual((args["end_ms"] as? NSNumber)?.int64Value, Int64(end.timeIntervalSince1970 * 1_000))
        try attach("D-App-deterministic-Pi-native-result", ["modelFixtureReplies": snapshot.models,
            "nativeFixtureReplies": snapshot.tools.count, "journalFixtureAcks": snapshot.journals,
            "realModelCalls": 0, "realEventKitCalls": 0, "executionSurface": "App-hosted deterministic fixture; verdict is in xcresult",
            "productionTaskEntryVerified": false, "nativeArgs": args])
    }

    func testCalendarSavedReceiptGuardPreservesPermissionFailureCodes() throws {
        let store = DCalendarPermissionStore()
        var enabled = true
        let executor = GuguCalendarExecutor(service: PhoneCalendarService(store: store), calendarEnabled: { enabled })
        func control(_ check: @escaping () throws -> Void = {}) -> GuguNativeToolControl {
            GuguNativeToolControl(checkActive: check,
                beginMutation: { XCTFail("Receipt validation consumed an approval") },
                finishMutation: { _ in XCTFail("Receipt validation wrote a receipt") })
        }
        func rejects(_ code: String, _ access: GuguNativeToolControl) {
            do {
                try executor.validateAccess(access)
                XCTFail("Receipt access unexpectedly allowed; expected \(code)")
            } catch let failure as GuguHostFailure {
                XCTAssertEqual(failure.code, code)
                XCTAssertFalse(failure.message.isEmpty)
            } catch { XCTFail("Permission code lost across App adapter: \(type(of: error))") }
        }
        for authorization in [PhoneCalendarAuthorization.notDetermined, .denied, .restricted, .writeOnly] {
            store.authorization = authorization
            rejects("os_permission", control())
        }
        store.authorization = .fullAccess
        enabled = false
        rejects("not_granted", control())
        enabled = true
        rejects("stale_context", control { throw GuguHostFailure(code: "stale_context", message: "D stale fixture context") })
        XCTAssertNoThrow(try executor.validateAccess(control()))
        try attach("D-App-calendar-receipt-access-guard", ["executionSurface": "Actual App adapter, injected permission store",
            "realModelCalls": 0, "realEventKitCalls": 0, "realHostJournalVerified": false,
            "cases": ["notDetermined", "denied", "restricted", "writeOnly", "category-off", "stale-context", "allowed"]])
    }

    func testCalendarFixtureThroughCExecutorAndIndependentEventKitOracle() throws {
        guard ProcessInfo.processInfo.environment["GUGU_D_ISOLATED_SIMULATOR"] == "1" else {
            throw XCTSkip("Requires A's line-owned signed-out simulator; no user calendar access")
        }
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            guard status == .fullAccess else { throw XCTSkip("Owner Calendar full access not yet granted; no preauthorization or prompt in this test") }
        } else {
            guard status == .authorized else { throw XCTSkip("Owner Calendar access not yet granted; no preauthorization or prompt in this test") }
        }
        guard Bundle.main.bundleIdentifier == "app.gugu.chat" else {
            throw GuguHostFailure(code: "wrong_test_host", message: "Calendar fixture requires the actual App TestHost")
        }
        let directory = try XCTUnwrap(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first)
            .appendingPathComponent("D-hosted-calendar", isDirectory: true)
        let manifestURL = directory.appendingPathComponent(UUID().uuidString + ".json")
        let fixture: PhoneCalendarSimulatorFixture
        do { fixture = try PhoneCalendarSimulatorFixture.open(manifestURL: manifestURL) }
        catch let error as PhoneCalendarFailure where error.code == "unavailable" {
            throw XCTSkip("No local fixture calendar source; no account source will be created")
        }
        addTeardownBlock {
            try fixture.remove(manifestURL: manifestURL)
            XCTAssertNil(EKEventStore().calendar(withIdentifier: fixture.manifest.calendarIdentifier))
        }
        let reopened = try PhoneCalendarSimulatorFixture.open(manifestURL: manifestURL)
        XCTAssertEqual(reopened.manifest.calendarIdentifier, fixture.manifest.calendarIdentifier)
        let manifestData = try Data(contentsOf: manifestURL)
        try attach("D-calendar-fixture-manifest", JSONSerialization.jsonObject(with: manifestData))
        let executor = GuguCalendarExecutor(service: PhoneCalendarService(store: try fixture.makeStore()), calendarEnabled: { true })
        let binding = context()
        let start: Int64 = 1_794_144_600_000
        let end = start + 3_600_000
        let title = "D isolated EventKit \(fixture.manifest.runID)"
        func oracle(_ events: [DExpectedCalendarEvent]) throws {
            try DCalendarSnapshotOracle.assertMatches(DCalendarOracleSpec(
                calendarIdentifier: fixture.manifest.calendarIdentifier, expectedCalendarTitle: fixture.manifest.title,
                start_ms: start - 86_400_000, end_ms: end + 86_400_000, events: events))
        }
        try oracle([])
        let created = try invoke(executor, binding, "calendar.events.create", ["title": title, "start_ms": start,
            "end_ms": end, "all_day": false, "calendar_id": fixture.manifest.calendarIdentifier])
        let eventId = try XCTUnwrap(created["event_id"] as? String)
        try oracle([DExpectedCalendarEvent(event_id: eventId, title: title, start_ms: start, end_ms: end, all_day: false)])
        let revised = title + " updated"
        _ = try invoke(executor, binding, "calendar.events.update", ["event_id": eventId, "title": revised])
        try oracle([DExpectedCalendarEvent(event_id: eventId, title: revised, start_ms: start, end_ms: end, all_day: false)])
        let listed = try invoke(executor, binding, "calendar.events.list", ["start_ms": start - 86_400_000, "end_ms": end + 86_400_000])
        let events = try XCTUnwrap(listed["events"] as? [[String: Any]])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?["title"] as? String, revised)
        _ = try invoke(executor, binding, "calendar.events.delete", ["event_id": eventId])
        try oracle([])
        try attach("D-calendar-fixture-result", ["calendarIdentifier": fixture.manifest.calendarIdentifier,
            "event_id": eventId, "executionSurface": "C executor and isolated EventKit fixture; verdict is in xcresult", "realUserCalendarAccessed": false,
            "realModelCalls": 0, "realPermissionPromptVerified": false, "realHostJournalVerified": false,
            "productionTaskEntryVerified": false])
    }

    private func invoke(_ executor: GuguCalendarExecutor, _ binding: GuguHostContext,
                        _ action: String, _ args: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: args, options: [.sortedKeys])
        let request = GuguNativeToolRequest(context: binding, requestId: UUID().uuidString, toolCallId: UUID().uuidString,
            actionName: action, argumentsJSON: String(decoding: data, as: UTF8.self),
            argumentsSHA256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            deadlineAtMs: Int64(Date().timeIntervalSince1970 * 1_000) + 30_000)
        let claims = DLocked(0)
        let receipts = DLocked(0)
        let control = GuguNativeToolControl(checkActive: {}, beginMutation: {
            let count = claims.access { $0 += 1; return $0 }
            guard count == 1 else { throw GuguHostFailure(code: "duplicate_conflict", message: "D approval fixture used twice") }
        }, finishMutation: { _ in receipts.access { $0 += 1 } })
        let completed = expectation(description: action)
        completed.assertForOverFulfill = true
        let result = DLocked<[String: Any]?>(nil)
        executor.execute(request, control: control) { envelope in result.access { $0 = envelope }; completed.fulfill() }
        wait(for: [completed], timeout: 10)
        let envelope = try XCTUnwrap(result.access { $0 })
        XCTAssertEqual(envelope["ok"] as? Bool, true, "\(envelope["code"] ?? "missing code")")
        let writes = action == "calendar.events.list" ? 0 : 1
        XCTAssertEqual(claims.access { $0 }, writes)
        XCTAssertEqual(receipts.access { $0 }, writes)
        return try XCTUnwrap(envelope["data"] as? [String: Any])
    }
}
// Real EventKit acceptance; permission state is prepared externally on an owned simulator.
extension DHostedRuntimeTests {
    func testRealEventKitPermissionBoundary() throws {
        let store = EventKitPhoneCalendarStore()
        let expected = try XCTUnwrap(ProcessInfo.processInfo.environment["GUGU_E6_AUTHORIZATION"])
        XCTAssertEqual(store.authorization.rawValue, expected)
        let service = PhoneCalendarService(store: store)
        let access = PhoneCalendarAccess(check: {}, beginWrite: { XCTFail("Denied write reached approval") }, finishWrite: { _ in XCTFail("Denied write committed") })
        if store.authorization != .fullAccess {
            for (method, args) in [("calendarList", ["start_ms": 1800000000000, "end_ms": 1800003600000] as [String: Any]),
                ("calendarCreate", ["title": "Must not exist", "start_ms": 1800000000000]),
                ("calendarUpdate", ["event_id": "missing", "title": "Must not change"]),
                ("calendarDelete", ["event_id": "missing"])] {
                XCTAssertThrowsError(try service.execute(method: method, arguments: args, access: access)) {
                    XCTAssertEqual(($0 as? PhoneCalendarFailure)?.code, "os_permission")
                }
            }
        }
        let owner = "af6219fb-8c01-4a2e-891a-e76c6a904e69", installation = "c6607a9f-1b34-44a7-8b9d-16f8722edaee"
        let binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation)
        let root = URL(fileURLWithPath: try XCTUnwrap(ProcessInfo.processInfo.environment["GUGU_HOME"]))
            .appendingPathComponent("permission-lifecycle")
        let ownerAccess = GuguIOSOwnerAccess(root: root, verifiedIdentity: { binding }, requireOwnerUI: {},
            calendarHasFullAccess: { store.authorization == .fullAccess }, revokeCalendarAccess: { _ in })
        // A system revocation retires persisted category consent. A later OS grant
        // cannot reconnect the original owner without another explicit connect.
        XCTAssertFalse(try ownerAccess.ownerSnapshot(expectedBinding: binding).calendarConnected)
        let attempt = try ownerAccess.beginCalendarConnection(expectedBinding: binding)
        if store.authorization == .fullAccess {
            XCTAssertTrue(try ownerAccess.finishCalendarConnection(attempt: attempt).calendarConnected)
        } else {
            XCTAssertThrowsError(try ownerAccess.finishCalendarConnection(attempt: attempt)) {
                XCTAssertEqual(($0 as? GuguHostFailure)?.code, "os_permission")
            }
            XCTAssertFalse(try ownerAccess.ownerSnapshot(expectedBinding: binding).calendarConnected)
        }
        try attach("E6-real-permission", ["authorization": store.authorization.rawValue,
            "calendarConnected": try ownerAccess.calendarEnabled(), "modelCalls": 0])
    }

    func testRealEventKitCRUDRecurrenceAndOwnerRevocation() throws {
        XCTAssertEqual(EventKitPhoneCalendarStore().authorization, .fullAccess)
        let root = URL(fileURLWithPath: try XCTUnwrap(ProcessInfo.processInfo.environment["GUGU_HOME"]))
            .appendingPathComponent("calendar-" + UUID().uuidString)
        let manifestURL = root.appendingPathComponent("manifest.json")
        let fixture = try PhoneCalendarSimulatorFixture.open(manifestURL: manifestURL)
        defer {
            do { try fixture.remove(manifestURL: manifestURL); try FileManager.default.removeItem(at: root) }
            catch { XCTFail("Fixture cleanup failed: \(error)") }
        }
        let service = PhoneCalendarService(store: try fixture.makeStore())
        let start: Int64 = 1800000000000, end = start + 3600000
        let oracle = EKEventStore()
        let calendar = try XCTUnwrap(oracle.calendar(withIdentifier: fixture.manifest.calendarIdentifier))
        let control = EKEvent(eventStore: oracle)
        control.calendar = calendar; control.title = "Original control"
        control.startDate = Date(timeIntervalSince1970: Double(start) / 1000)
        control.endDate = Date(timeIntervalSince1970: Double(end) / 1000)
        try oracle.save(control, span: .thisEvent)
        let controlID = try XCTUnwrap(control.eventIdentifier)
        let access = PhoneCalendarAccess(check: {}, beginWrite: {}, finishWrite: { _ in })
        let receipt = try service.execute(method: "calendarCreate", arguments: ["title": "Created", "start_ms": start,
            "end_ms": end, "calendar_id": fixture.manifest.calendarIdentifier], access: access)
        let id = try XCTUnwrap(receipt["event_id"] as? String)
        XCTAssertNotEqual(id, controlID)
        func readOracle() throws -> [DObservedCalendarEvent] {
            try DCalendarSnapshotOracle.read(DCalendarOracleSpec(calendarIdentifier: fixture.manifest.calendarIdentifier,
                expectedCalendarTitle: fixture.manifest.title, start_ms: start - 1, end_ms: end + 1, events: []))
        }
        XCTAssertEqual(try readOracle().count, 2)
        let listed = try service.execute(method: "calendarList", arguments: ["start_ms": start - 1, "end_ms": end + 1], access: access)
        XCTAssertEqual((listed["events"] as? [[String: Any]])?.count, 2)
        _ = try service.execute(method: "calendarUpdate", arguments: ["event_id": id, "title": "Updated"], access: access)
        XCTAssertEqual(try readOracle().first { $0.event_id == id }?.title, "Updated")
        XCTAssertEqual(try readOracle().first { $0.event_id == controlID }?.title, "Original control")
        _ = try service.execute(method: "calendarDelete", arguments: ["event_id": id], access: access)
        XCTAssertEqual(try readOracle().map(\.event_id), [controlID])

        let recurring = EKEvent(eventStore: oracle)
        recurring.calendar = calendar; recurring.title = "Recurring control"
        recurring.startDate = control.startDate; recurring.endDate = control.endDate
        recurring.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: .daily, interval: 1, end: EKRecurrenceEnd(occurrenceCount: 3)))
        try oracle.save(recurring, span: .thisEvent)
        let recurringID = try XCTUnwrap(recurring.eventIdentifier)
        let noApproval = PhoneCalendarAccess(check: {}, beginWrite: { XCTFail("Recurrence consumed approval") }, finishWrite: { _ in XCTFail("Recurrence committed") })
        for (method, args) in [("calendarUpdate", ["event_id": recurringID, "title": "Wrong"]), ("calendarDelete", ["event_id": recurringID])] {
            XCTAssertThrowsError(try service.execute(method: method, arguments: args, access: noApproval)) {
                XCTAssertEqual(($0 as? PhoneCalendarFailure)?.code, "unsupported_recurrence_scope")
            }
        }
        let series = try service.execute(method: "calendarList", arguments: ["start_ms": start - 1, "end_ms": end + 3 * 86400000], access: access)
        XCTAssertEqual((series["events"] as? [[String: Any]])?.count, 4)
        XCTAssertEqual(try readOracle().first { $0.event_id == recurringID }?.title, "Recurring control")
        XCTAssertThrowsError(try service.execute(method: "calendarCreate", arguments: ["title": "Wrong", "start_ms": start, "recurrence": "daily"], access: noApproval)) {
            XCTAssertEqual(($0 as? PhoneCalendarFailure)?.code, "invalid_args")
        }
        let owner = UUID().uuidString.lowercased(), installation = UUID().uuidString.lowercased()
        let binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation)
        let ownerAccess = GuguIOSOwnerAccess(root: root.appendingPathComponent("owner"), verifiedIdentity: { binding },
            requireOwnerUI: {}, calendarHasFullAccess: { EventKitPhoneCalendarStore().authorization == .fullAccess }, revokeCalendarAccess: { revoked in XCTAssertEqual(revoked, binding) })
        let attempt = try ownerAccess.beginCalendarConnection(expectedBinding: binding)
        _ = try ownerAccess.finishCalendarConnection(attempt: attempt)
        let checked = PhoneCalendarAccess(check: {
            guard try ownerAccess.calendarEnabled(expectedBinding: binding) else { throw GuguHostFailure(code: "not_granted", message: "Disconnected") }
        }, beginWrite: { XCTFail("Revoked owner reached write") }, finishWrite: { _ in XCTFail("Revoked owner committed") })
        _ = try ownerAccess.disconnectCalendar(expectedBinding: binding)
        for (method, args) in [("calendarCreate", ["title": "Wrong", "start_ms": start] as [String: Any]),
            ("calendarUpdate", ["event_id": controlID, "title": "Wrong"]), ("calendarDelete", ["event_id": controlID])] {
            XCTAssertThrowsError(try service.execute(method: method, arguments: args, access: checked)) {
                XCTAssertEqual(($0 as? GuguHostFailure)?.code, "not_granted")
            }
        }
        XCTAssertEqual(try readOracle().first { $0.event_id == controlID }?.title, "Original control")
        try attach("E6-real-calendar", ["calendarID": fixture.manifest.calendarIdentifier, "calendarTitle": fixture.manifest.title,
            "createdID": id, "controlID": controlID, "recurringID": recurringID, "modelCalls": 0])
    }
}
#else
#error("DHostedRuntimeTests is restricted to Debug iOS Simulator App-hosted XCTest")
#endif
