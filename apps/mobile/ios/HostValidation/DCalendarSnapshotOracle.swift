#if DEBUG && os(iOS) && targetEnvironment(simulator)
import EventKit
import Foundation
import XCTest

struct DCalendarOracleSpec: Codable {
    let calendarIdentifier: String
    let expectedCalendarTitle: String
    let expectedSourceIdentifier: String
    let start_ms: Int64
    let end_ms: Int64
    let events: [DExpectedCalendarEvent]
}

struct DExpectedCalendarEvent: Codable {
    let event_id: String?
    let title: String
    let start_ms: Int64
    let end_ms: Int64
    let all_day: Bool
}

struct DObservedCalendarEvent: Codable {
    let event_id: String
    let calendar_id: String
    let title: String
    let start_ms: Int64
    let end_ms: Int64
    let all_day: Bool
}

struct DCalendarOracleSnapshot: Codable {
    let calendar_id: String
    let calendar_title: String
    let source_id: String
    let source_type: Int
    let allowsContentModifications: Bool
    let authorizationRawValue: Int
    let authorizationAfterRawValue: Int
    let observedAt_ms: Int64
    let pid: Int
    let events: [DObservedCalendarEvent]
}

enum DCalendarOracleFailure: Error {
    case unsafeFixture, invalidRange, missingReadPermission, fixtureNotFound
    case missingEventIdentifier, snapshotMismatch
}

enum DCalendarSnapshotOracle {
    /// Fresh EventKit objects, exact fixture ID/source, no permission request or writes.
    static func snapshot(_ spec: DCalendarOracleSpec) throws -> DCalendarOracleSnapshot {
        let prefix = "Gugu iOS Fixture "
        guard !spec.calendarIdentifier.isEmpty, !spec.expectedSourceIdentifier.isEmpty,
              spec.expectedCalendarTitle.hasPrefix(prefix),
              UUID(uuidString: String(spec.expectedCalendarTitle.dropFirst(prefix.count))) != nil else {
            throw DCalendarOracleFailure.unsafeFixture
        }
        guard spec.start_ms > 0, spec.end_ms > spec.start_ms,
              spec.end_ms - spec.start_ms <= 604_800_000 else {
            throw DCalendarOracleFailure.invalidRange
        }
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            guard status == .fullAccess else { throw DCalendarOracleFailure.missingReadPermission }
        } else {
            guard status == .authorized else { throw DCalendarOracleFailure.missingReadPermission }
        }
        let store = EKEventStore()
        guard let calendar = store.calendar(withIdentifier: spec.calendarIdentifier),
              let source = calendar.source,
              calendar.title == spec.expectedCalendarTitle, source.sourceType == .local,
              source.sourceIdentifier == spec.expectedSourceIdentifier,
              calendar.allowsContentModifications else {
            throw DCalendarOracleFailure.fixtureNotFound
        }
        let predicate = store.predicateForEvents(
            withStart: Date(timeIntervalSince1970: Double(spec.start_ms) / 1_000),
            end: Date(timeIntervalSince1970: Double(spec.end_ms) / 1_000), calendars: [calendar])
        let observed = try store.events(matching: predicate).map { event in
            guard let eventCalendar = event.calendar,
                  eventCalendar.calendarIdentifier == spec.calendarIdentifier,
                  let identifier = event.eventIdentifier, !identifier.isEmpty else {
                throw DCalendarOracleFailure.missingEventIdentifier
            }
            return DObservedCalendarEvent(event_id: identifier,
                calendar_id: eventCalendar.calendarIdentifier, title: event.title ?? "",
                start_ms: Int64((event.startDate.timeIntervalSince1970 * 1_000).rounded()),
                end_ms: Int64((event.endDate.timeIntervalSince1970 * 1_000).rounded()),
                all_day: event.isAllDay)
        }
        let after = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            guard after == .fullAccess else { throw DCalendarOracleFailure.missingReadPermission }
        } else {
            guard after == .authorized else { throw DCalendarOracleFailure.missingReadPermission }
        }
        return DCalendarOracleSnapshot(calendar_id: calendar.calendarIdentifier,
            calendar_title: calendar.title, source_id: source.sourceIdentifier,
            source_type: source.sourceType.rawValue,
            allowsContentModifications: calendar.allowsContentModifications,
            authorizationRawValue: status.rawValue, authorizationAfterRawValue: after.rawValue,
            observedAt_ms: Int64(Date().timeIntervalSince1970 * 1_000),
            pid: Int(ProcessInfo.processInfo.processIdentifier), events: observed)
    }

    static func read(_ spec: DCalendarOracleSpec) throws -> [DObservedCalendarEvent] {
        try snapshot(spec).events
    }

    static func assertMatches(_ spec: DCalendarOracleSpec,
                              file: StaticString = #filePath, line: UInt = #line) throws {
        try assertMatches(spec, observed: read(spec), file: file, line: line)
    }

    /// Assert the exact snapshot already attached by the caller; never re-read to hide a mismatch.
    static func assertMatches(_ spec: DCalendarOracleSpec, observed: [DObservedCalendarEvent],
                              file: StaticString = #filePath, line: UInt = #line) throws {
        var remaining = observed
        XCTAssertEqual(remaining.count, spec.events.count, "Fixture event count", file: file, line: line)
        guard remaining.count == spec.events.count else { throw DCalendarOracleFailure.snapshotMismatch }
        for wanted in spec.events {
            guard let id = wanted.event_id, !id.isEmpty,
                  let index = remaining.firstIndex(where: { $0.event_id == id }) else {
                XCTFail("Exact fixture event ID missing", file: file, line: line)
                throw DCalendarOracleFailure.missingEventIdentifier
            }
            let actual = remaining.remove(at: index)
            XCTAssertEqual(actual.calendar_id, spec.calendarIdentifier, file: file, line: line)
            XCTAssertEqual(actual.title, wanted.title, file: file, line: line)
            XCTAssertEqual(actual.start_ms, wanted.start_ms, file: file, line: line)
            XCTAssertEqual(actual.end_ms, wanted.end_ms, file: file, line: line)
            XCTAssertEqual(actual.all_day, wanted.all_day, file: file, line: line)
            guard actual.calendar_id == spec.calendarIdentifier, actual.title == wanted.title,
                  actual.start_ms == wanted.start_ms, actual.end_ms == wanted.end_ms,
                  actual.all_day == wanted.all_day else { throw DCalendarOracleFailure.snapshotMismatch }
        }
        XCTAssertTrue(remaining.isEmpty, "Unexpected fixture events", file: file, line: line)
        guard remaining.isEmpty else { throw DCalendarOracleFailure.snapshotMismatch }
    }
}
#else
#error("DCalendarSnapshotOracle is restricted to Debug iOS Simulator XCTest targets")
#endif
