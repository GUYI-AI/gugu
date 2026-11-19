import Foundation
import Testing
@testable import GuguPhoneCalendar

private final class Store: PhoneCalendarStore {
    var authorization: PhoneCalendarAuthorization = .fullAccess
    var timezone = TimeZone(secondsFromGMT: 0)!
    var reads = 0
    var writes = 0
    var prepares = 0
    var onRead: () throws -> Void = {}
    var onPrepare: () throws -> Void = {}
    var onCommit: () throws -> Void = {}
    var events = [PhoneCalendarEvent(eventID: "fixture-event", title: "Private fixture", startMS: 1, endMS: 2)]

    func read(start: Int64, end: Int64, limit: Int, checkpoint: @escaping () throws -> Void) throws -> [PhoneCalendarEvent] {
        reads += 1
        try onRead()
        try checkpoint()
        return events
    }

    func prepare(_ command: PhoneCalendarCommand) throws -> PhoneCalendarPreparedWrite {
        prepares += 1
        try onPrepare()
        return PhoneCalendarPreparedWrite {
            self.writes += 1
            try self.onCommit()
            return ["event_id": "fixture-event"]
        }
    }
}

@Suite struct PhoneCalendarServiceTests {
    private let create: [String: Any] = ["title": "Fixture", "start_ms": 1, "end_ms": 2]

    private func access(check: @escaping () throws -> Void = {}, begin: @escaping () throws -> Void = {},
                        finish: @escaping ([String: Any]) throws -> Void = { _ in }) -> PhoneCalendarAccess {
        PhoneCalendarAccess(check: check, beginWrite: begin, finishWrite: finish)
    }

    private func fails(_ code: String, _ body: () throws -> Void) {
        do {
            try body()
            Issue.record("Expected failure: \(code)")
        } catch { #expect((error as? PhoneCalendarFailure)?.code == code) }
    }

    @Test func testEveryMissingSystemPermissionRejectsWithoutReadingOrClaimingApproval() {
        for state in [PhoneCalendarAuthorization.notDetermined, .denied, .restricted, .writeOnly] {
            let store = Store()
            store.authorization = state
            let service = PhoneCalendarService(store: store)
            var claimed = 0
            for method in ["calendarList", "calendarCreate", "calendarUpdate", "calendarDelete"] {
                fails("os_permission") {
                    _ = try service.execute(method: method, arguments: [:], access: access(begin: { claimed += 1 }))
                }
            }
            #expect(store.reads + store.prepares + store.writes + claimed == 0)
        }
    }

    @Test func testRevocationDuringReadDoesNotReleasePrivateEvents() {
        let store = Store()
        store.onRead = { store.authorization = .denied }
        fails("os_permission") {
            _ = try PhoneCalendarService(store: store).execute(method: "calendarList",
                arguments: ["start_ms": 0, "end_ms": 3], access: access())
        }
        #expect(store.reads == 1)
    }

    @Test func testCancellationBeforeAdmissionHasNoCalendarAccess() {
        let store = Store()
        fails("cancelled") {
            _ = try PhoneCalendarService(store: store).execute(method: "calendarCreate", arguments: create,
                access: access(check: { throw PhoneCalendarFailure("cancelled", "Cancelled") }))
        }
        #expect(store.prepares + store.writes == 0)
    }

    @Test func testRevocationDuringPreparationDoesNotConsumeApproval() {
        let store = Store()
        store.onPrepare = { store.authorization = .denied }
        var begins = 0
        fails("os_permission") {
            _ = try PhoneCalendarService(store: store).execute(method: "calendarCreate", arguments: create,
                access: access(begin: { begins += 1 }))
        }
        #expect(begins == 0)
        #expect(store.writes == 0)
    }

    @Test func testCancellationImmediatelyAfterClaimDoesNotWrite() {
        let store = Store()
        var cancelled = false
        fails("cancelled") {
            _ = try PhoneCalendarService(store: store).execute(method: "calendarCreate", arguments: create,
                access: access(check: {
                    if cancelled { throw PhoneCalendarFailure("cancelled", "Cancelled") }
                }, begin: { cancelled = true }))
        }
        #expect(store.writes == 0)
    }

    @Test func testKnownReceiptSavedBeforePostCommitRevocation() {
        let store = Store()
        store.onCommit = { store.authorization = .denied }
        var receipt: [String: Any]?
        fails("os_permission") {
            _ = try PhoneCalendarService(store: store).execute(method: "calendarCreate", arguments: create,
                access: access(finish: { receipt = $0 }))
        }
        #expect(store.writes == 1)
        #expect(receipt?["event_id"] as? String == "fixture-event")
    }

    @Test func testSuccessfulMutationClaimsExactlyOnceBeforeCommit() throws {
        let store = Store()
        var order: [String] = []
        store.onCommit = { order.append("commit") }
        let result = try PhoneCalendarService(store: store).execute(method: "calendarCreate", arguments: create,
            access: access(begin: { order.append("claim") }, finish: { _ in order.append("receipt") }))
        #expect(order == ["claim", "commit", "receipt"])
        #expect(result["event_id"] as? String == "fixture-event")
        #expect(store.writes == 1)
    }

    @Test func testCancellationDuringCommitStillPersistsKnownOutcome() {
        let store = Store()
        var cancelled = false
        var receipts = 0
        store.onCommit = { cancelled = true }
        fails("cancelled") {
            _ = try PhoneCalendarService(store: store).execute(method: "calendarCreate", arguments: create,
                access: access(check: {
                    if cancelled { throw PhoneCalendarFailure("cancelled", "Cancelled") }
                }, finish: { _ in receipts += 1 }))
        }
        #expect(store.writes == 1)
        #expect(receipts == 1)
    }

    @Test func testReceiptPersistenceFailureMarksUncertainWrite() {
        let store = Store()
        fails("execution_unknown") {
            _ = try PhoneCalendarService(store: store).execute(method: "calendarCreate", arguments: create,
                access: access(finish: { _ in throw CocoaError(.fileWriteOutOfSpace) }))
        }
        #expect(store.writes == 1)
    }

    @Test func testUnsupportedRecurringScopeRejectsBeforeApprovalOrWrite() {
        let store = Store()
        store.onPrepare = { throw PhoneCalendarFailure("unsupported_recurrence_scope", "Unverified series scope") }
        var begins = 0
        fails("unsupported_recurrence_scope") {
            _ = try PhoneCalendarService(store: store).execute(method: "calendarDelete", arguments: ["event_id": "fixture-series"],
                access: access(begin: { begins += 1 }))
        }
        #expect(begins + store.writes == 0)
    }

    @Test func testHostDuplicateOrPendingRejectionCannotReachEventKitCommit() {
        for code in ["duplicate_conflict", "execution_unknown"] {
            let store = Store()
            fails(code) {
                _ = try PhoneCalendarService(store: store).execute(method: "calendarCreate", arguments: create,
                    access: access(begin: { throw PhoneCalendarFailure(code, "Journal rejects this invocation") }))
            }
            #expect(store.writes == 0)
        }
    }

    @Test func testSavedReceiptRequiresCurrentSystemAndCategoryPermission() {
        let store = Store()
        let service = PhoneCalendarService(store: store)
        store.authorization = .writeOnly
        fails("os_permission") { try service.validateAccess(access()) }
        store.authorization = .fullAccess
        fails("not_granted") {
            try service.validateAccess(access(check: { throw PhoneCalendarFailure("not_granted", "Category revoked") }))
        }
        #expect(store.reads + store.writes == 0)
    }

    @Test func testModelConfirmationCannotBePassedAsNativeApproval() {
        var arguments = create
        arguments["confirmed"] = true
        let store = Store()
        var begins = 0
        fails("invalid_args") {
            _ = try PhoneCalendarService(store: store).execute(method: "calendarCreate", arguments: arguments,
                access: access(begin: { begins += 1 }))
        }
        #expect(begins + store.writes == 0)
    }

    @Test func testStrictNumbersAndEffectiveDateRange() {
        for bad in [true as Any, 1.5, Double.infinity, "1", NSNull()] {
            fails("invalid_args") {
                _ = try PhoneCalendarCommand.parse(method: "calendarList", arguments: ["start_ms": bad, "end_ms": 10])
            }
        }
        fails("invalid_args") {
            _ = try PhoneCalendarCommand.parse(method: "calendarCreate", arguments: ["title": "Fixture", "start_ms": 253_402_300_799_999])
        }
        fails("invalid_args") {
            _ = try PhoneCalendarCommand.parse(method: "calendarUpdate", arguments: ["event_id": "id"])
        }
        fails("invalid_args") {
            _ = try PhoneCalendarCommand.parse(method: "calendarCreate", arguments: ["title": "Fixture", "start_ms": 1, "all_day": true])
        }
    }
}
