#if DEBUG && targetEnvironment(simulator)
import EventKit
import XCTest

/// D-owned test source. Add only to an app-hosted iOS simulator XCTest target.
/// This code does not invoke C's service, request permission, or mutate EventKit.
struct DCalendarOracleSpec: Decodable {
    let calendarIdentifier: String
    let expectedCalendarTitle: String
    let start_ms: Int64
    let end_ms: Int64
    let events: [DExpectedCalendarEvent]
}

struct DExpectedCalendarEvent: Decodable {
    let event_id: String?
    let title: String
    let start_ms: Int64
    let end_ms: Int64
    let all_day: Bool
}

struct DObservedCalendarEvent: Codable {
    let event_id: String
    let title: String
    let start_ms: Int64
    let end_ms: Int64
    let all_day: Bool
}

enum DCalendarOracleFailure: Error {
    case unsafeFixture
    case invalidRange
    case missingReadPermission
    case fixtureNotFound
    case missingEventIdentifier
}

enum DCalendarSnapshotOracle {
    /// Use the fixture calendar ID/title frozen by C and D-authored expected values.
    /// The caller owns a dedicated simulator; never enable account/calendar sync in it.
    static func read(_ spec: DCalendarOracleSpec) throws -> [DObservedCalendarEvent] {
        guard !spec.calendarIdentifier.isEmpty,
              spec.expectedCalendarTitle.hasPrefix("Gugu iOS Fixture "),
              spec.expectedCalendarTitle.count > "Gugu iOS Fixture ".count else {
            throw DCalendarOracleFailure.unsafeFixture
        }
        guard spec.start_ms > 0, spec.end_ms > spec.start_ms,
              spec.end_ms - spec.start_ms <= 604_800_000 else {
            throw DCalendarOracleFailure.invalidRange
        }
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            guard status == .fullAccess else {
                throw DCalendarOracleFailure.missingReadPermission
            }
        } else {
            guard status == .authorized else {
                throw DCalendarOracleFailure.missingReadPermission
            }
        }

        // A fresh store avoids validating against a snapshot retained by C's service.
        let store = EKEventStore()
        guard let calendar = store.calendar(withIdentifier: spec.calendarIdentifier),
              calendar.title == spec.expectedCalendarTitle,
              calendar.source.sourceType == .local else {
            throw DCalendarOracleFailure.fixtureNotFound
        }
        let predicate = store.predicateForEvents(
            withStart: Date(timeIntervalSince1970: Double(spec.start_ms) / 1_000),
            end: Date(timeIntervalSince1970: Double(spec.end_ms) / 1_000),
            calendars: [calendar]
        )
        return try store.events(matching: predicate).map { event in
            guard event.calendar.calendarIdentifier == spec.calendarIdentifier,
                  let identifier = event.eventIdentifier, !identifier.isEmpty else {
                throw DCalendarOracleFailure.missingEventIdentifier
            }
            return DObservedCalendarEvent(
                event_id: identifier,
                title: event.title ?? "",
                start_ms: Int64((event.startDate.timeIntervalSince1970 * 1_000).rounded()),
                end_ms: Int64((event.endDate.timeIntervalSince1970 * 1_000).rounded()),
                all_day: event.isAllDay
            )
        }
    }

    /// Exact count catches duplicate writes. Expected data must come from the scenario,
    /// not from the product's own returned event list.
    static func assertMatches(
        _ spec: DCalendarOracleSpec,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        var remaining = try read(spec)
        XCTAssertEqual(remaining.count, spec.events.count, "Fixture event count", file: file, line: line)
        guard remaining.count == spec.events.count else { return }
        for wanted in spec.events {
            let index = remaining.firstIndex { observed in
                if let eventId = wanted.event_id { return observed.event_id == eventId }
                return observed.title == wanted.title && observed.start_ms == wanted.start_ms
                    && observed.end_ms == wanted.end_ms && observed.all_day == wanted.all_day
            }
            guard let index else {
                XCTFail("Expected fixture event missing: \(wanted.title)", file: file, line: line)
                return
            }
            let observed = remaining.remove(at: index)
            XCTAssertEqual(observed.title, wanted.title, file: file, line: line)
            XCTAssertEqual(observed.start_ms, wanted.start_ms, file: file, line: line)
            XCTAssertEqual(observed.end_ms, wanted.end_ms, file: file, line: line)
            XCTAssertEqual(observed.all_day, wanted.all_day, file: file, line: line)
        }
        XCTAssertTrue(remaining.isEmpty, "Unexpected fixture events", file: file, line: line)
    }
}
#else
#error("DCalendarSnapshotOracle is restricted to Debug iOS Simulator XCTest targets")
#endif
