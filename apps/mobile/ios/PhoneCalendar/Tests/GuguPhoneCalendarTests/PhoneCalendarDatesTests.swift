import Foundation
import Testing
@testable import GuguPhoneCalendar

@Suite struct PhoneCalendarDatesTests {
    private func day(_ text: String) -> Int64 {
        let formatter = ISO8601DateFormatter()
        return Int64(formatter.date(from: text + "T00:00:00Z")!.timeIntervalSince1970 * 1000)
    }

    @Test func testAllDayDatesRoundTripAcrossDSTAndOppositeOffsets() throws {
        for identifier in ["America/Los_Angeles", "Asia/Shanghai", "Pacific/Kiritimati", "Europe/Berlin"] {
            let zone = try #require(TimeZone(identifier: identifier))
            for date in ["2026-03-08", "2026-03-09", "2026-11-01", "2026-11-02"] {
                let encoded = day(date)
                let local = try PhoneCalendarDates.localDay(fromUTCDateMS: encoded, timezone: zone)
                #expect(try PhoneCalendarDates.utcDateMS(fromLocalDay: local, timezone: zone) == encoded)
                let parts = PhoneCalendarDates.calendar(zone).dateComponents([.hour, .minute], from: local)
                #expect(parts.hour == 0)
                #expect(parts.minute == 0)
            }
        }
    }

    @Test func testAllDayDurationUsesCalendarDaysAcrossDST() throws {
        let zone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        let first = try PhoneCalendarDates.localDay(fromUTCDateMS: day("2026-03-08"), timezone: zone)
        let until = try PhoneCalendarDates.localDay(fromUTCDateMS: day("2026-03-09"), timezone: zone)
        #expect(until.timeIntervalSince(first) == 23 * 3600)
    }

    @Test func testSkippedCalendarDateCannotMoveSilentlyToAnotherDay() throws {
        let zone = try #require(TimeZone(identifier: "Pacific/Apia"))
        #expect(throws: PhoneCalendarFailure.self) {
            try PhoneCalendarDates.localDay(fromUTCDateMS: day("2011-12-30"), timezone: zone)
        }
    }

    @Test func testLongQueryHasContiguousUntruncatedWindows() throws {
        let from = day("2018-02-28")
        let until = day("2026-03-01")
        let windows = try PhoneCalendarDates.queryWindows(start: from, end: until)
        #expect(windows.count == 9)
        #expect(windows.first?.start == Date(timeIntervalSince1970: Double(from) / 1000))
        #expect(windows.last?.end == Date(timeIntervalSince1970: Double(until) / 1000))
        for index in windows.indices {
            #expect(windows[index].duration <= 366 * 86400)
            if index > 0 { #expect(windows[index - 1].end == windows[index].start) }
        }
    }
}
