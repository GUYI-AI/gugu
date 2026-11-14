import Foundation

public enum PhoneCalendarDates {
    private static let utc = TimeZone(secondsFromGMT: 0)!

    static func calendar(_ zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }

    /// Android's raw all-day contract carries a UTC-encoded DATE, not an instant in UTC.
    public static func localDay(fromUTCDateMS ms: Int64, timezone: TimeZone) throws -> Date {
        let utcCalendar = calendar(utc)
        let parts = utcCalendar.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: Double(ms) / 1000))
        let local = calendar(timezone)
        guard let date = local.date(from: parts),
              local.dateComponents([.year, .month, .day], from: date) == parts else {
            throw PhoneCalendarFailure("invalid_args", "Calendar date does not exist in this timezone")
        }
        return date
    }

    public static func utcDateMS(fromLocalDay date: Date, timezone: TimeZone) throws -> Int64 {
        let parts = calendar(timezone).dateComponents([.year, .month, .day], from: date)
        guard let encoded = calendar(utc).date(from: parts) else {
            throw PhoneCalendarFailure("invalid_args", "Calendar date cannot be represented")
        }
        return Int64((encoded.timeIntervalSince1970 * 1000).rounded())
    }

    /// EventKit silently narrows >4-year queries. Query consecutive one-year windows instead.
    public static func queryWindows(start: Int64, end: Int64) throws -> [DateInterval] {
        try PhoneCalendarCommand.validRange(start, end)
        var cursor = Date(timeIntervalSince1970: Double(start) / 1000)
        let finish = Date(timeIntervalSince1970: Double(end) / 1000)
        let cal = calendar(utc)
        var result: [DateInterval] = []
        while cursor < finish {
            guard let next = cal.date(byAdding: .year, value: 1, to: cursor), next > cursor else {
                throw PhoneCalendarFailure("invalid_args", "Unsupported calendar query range")
            }
            let until = min(next, finish)
            result.append(DateInterval(start: cursor, end: until))
            cursor = until
        }
        return result
    }
}
