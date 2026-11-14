import CoreFoundation
import Foundation

public enum PhoneCalendarAuthorization: String {
    case notDetermined, denied, restricted, writeOnly, fullAccess
}

public struct PhoneCalendarFailure: Error {
    public let code: String
    public let message: String
    /// A commit was attempted; never automatically retry this invocation.
    public let writeMayHaveCommitted: Bool

    public init(_ code: String, _ message: String, writeMayHaveCommitted: Bool = false) {
        self.code = code
        self.message = message
        self.writeMayHaveCommitted = writeMayHaveCommitted
    }
}

/// These closures are supplied by the native host, never decoded from tool arguments.
/// The host owns identity, installation, task generation, cancellation and the durable journal.
public struct PhoneCalendarAccess {
    public let check: () throws -> Void
    /// Atomically consume a local approval and persist pending before the EventKit commit.
    /// Duplicate receipts are resolved by the host, after revalidating current access.
    public let beginWrite: () throws -> Void
    /// Persist even when cancellation arrived during the synchronous EventKit commit.
    public let finishWrite: ([String: Any]) throws -> Void

    public init(check: @escaping () throws -> Void,
                beginWrite: @escaping () throws -> Void,
                finishWrite: @escaping ([String: Any]) throws -> Void) {
        self.check = check
        self.beginWrite = beginWrite
        self.finishWrite = finishWrite
    }
}

public struct PhoneCalendarEvent {
    public let eventID: String
    public let title: String
    public let startMS: Int64
    public let endMS: Int64
    public let allDay: Bool
    public let location: String
    public let notes: String
    public let calendarName: String
    public let calendarID: String

    public init(eventID: String, title: String, startMS: Int64, endMS: Int64,
                allDay: Bool = false, location: String = "", notes: String = "",
                calendarName: String = "", calendarID: String = "") {
        self.eventID = eventID
        self.title = title
        self.startMS = startMS
        self.endMS = endMS
        self.allDay = allDay
        self.location = location
        self.notes = notes
        self.calendarName = calendarName
        self.calendarID = calendarID
    }

    public var json: [String: Any] {
        ["event_id": eventID, "title": title, "start_ms": startMS, "end_ms": endMS,
         "all_day": allDay, "location": location, "description": notes,
         "calendar": calendarName, "calendar_id": calendarID]
    }
}

public enum PhoneCalendarCommand {
    case list(start: Int64, end: Int64, limit: Int)
    case create(PhoneCalendarCreate)
    case update(PhoneCalendarUpdate)
    case delete(eventID: String)

    public static func parse(method: String, arguments: [String: Any]) throws -> Self {
        let args = PhoneCalendarArguments(arguments)
        switch method {
        case "calendarList":
            try args.only(["start_ms", "end_ms", "limit"])
            let start = try args.integer("start_ms")
            let end = try args.integer("end_ms")
            try validRange(start, end)
            let limit = try args.optionalInteger("limit") ?? 100
            guard (1...500).contains(limit) else { throw invalid("limit must be between 1 and 500") }
            return .list(start: start, end: end, limit: Int(limit))
        case "calendarCreate":
            try args.only(["title", "start_ms", "end_ms", "all_day", "location", "description", "reminder_minutes", "calendar_id"])
            let title = try args.text("title", nonempty: true)
            let start = try args.integer("start_ms")
            let allDay = try args.boolean("all_day") ?? false
            let end = try args.optionalInteger("end_ms") ?? start + (allDay ? 86_400_000 : 3_600_000)
            try validRange(start, end)
            if allDay && (start % 86_400_000 != 0 || end % 86_400_000 != 0) {
                throw invalid("All-day dates must use UTC date boundaries")
            }
            let reminder = try args.optionalInteger("reminder_minutes")
            if let reminder, !(0...40_320).contains(reminder) { throw invalid("Invalid reminder_minutes") }
            return .create(PhoneCalendarCreate(title: title, startMS: start, endMS: end,
                allDay: allDay, location: try args.optionalText("location"), notes: try args.optionalText("description"),
                reminderMinutes: reminder.map(Int.init), calendarID: try args.optionalText("calendar_id", nonempty: true)))
        case "calendarUpdate":
            try args.only(["event_id", "title", "start_ms", "end_ms", "location", "description"])
            let update = try PhoneCalendarUpdate(eventID: args.text("event_id", nonempty: true),
                title: args.optionalText("title"), startMS: args.optionalInteger("start_ms"),
                endMS: args.optionalInteger("end_ms"), location: args.optionalText("location"), notes: args.optionalText("description"))
            guard update.hasChanges else { throw invalid("No event fields to update") }
            if let start = update.startMS, let end = update.endMS { try validRange(start, end) }
            return .update(update)
        case "calendarDelete":
            try args.only(["event_id"])
            return .delete(eventID: try args.text("event_id", nonempty: true))
        default:
            throw PhoneCalendarFailure("unknown_action", "Calendar action is not available")
        }
    }

    static func invalid(_ message: String) -> PhoneCalendarFailure { .init("invalid_args", message) }
    static func validRange(_ start: Int64, _ end: Int64) throws {
        guard start >= -62_135_596_800_000, end <= 253_402_300_799_999, end > start else {
            throw invalid("end_ms must be after start_ms within the supported date range")
        }
    }
}

public struct PhoneCalendarCreate {
    public let title: String
    public let startMS: Int64
    public let endMS: Int64
    public let allDay: Bool
    public let location: String?
    public let notes: String?
    public let reminderMinutes: Int?
    public let calendarID: String?
}

public struct PhoneCalendarUpdate {
    public let eventID: String
    public let title: String?
    public let startMS: Int64?
    public let endMS: Int64?
    public let location: String?
    public let notes: String?
    var hasChanges: Bool { title != nil || startMS != nil || endMS != nil || location != nil || notes != nil }
}

private struct PhoneCalendarArguments {
    let values: [String: Any]
    init(_ values: [String: Any]) { self.values = values }
    func only(_ keys: Set<String>) throws {
        guard Set(values.keys).isSubset(of: keys) else { throw PhoneCalendarCommand.invalid("Unsupported calendar argument") }
    }
    func text(_ key: String, nonempty: Bool = false) throws -> String {
        guard let value = try optionalText(key, nonempty: nonempty) else {
            throw PhoneCalendarCommand.invalid("Missing \(key)")
        }
        return key == "title" && nonempty ? value.trimmingCharacters(in: .whitespacesAndNewlines) : value
    }
    func optionalText(_ key: String, nonempty: Bool = false) throws -> String? {
        guard let value = values[key] else { return nil }
        guard let string = value as? String else { throw PhoneCalendarCommand.invalid("Invalid \(key)") }
        if nonempty && string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw PhoneCalendarCommand.invalid("Empty \(key)")
        }
        return string
    }
    func integer(_ key: String) throws -> Int64 {
        guard let value = try optionalInteger(key) else { throw PhoneCalendarCommand.invalid("Missing \(key)") }
        return value
    }
    func optionalInteger(_ key: String) throws -> Int64? {
        guard let value = values[key] else { return nil }
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw PhoneCalendarCommand.invalid("Invalid \(key)")
        }
        let double = number.doubleValue
        // JavaScript exact integers and Foundation's supported Gregorian date range.
        guard double.isFinite, double.rounded() == double,
              (-62_135_596_800_000...253_402_300_799_999).contains(double) else {
            throw PhoneCalendarCommand.invalid("Out-of-range \(key)")
        }
        return number.int64Value
    }
    func boolean(_ key: String) throws -> Bool? {
        guard let value = values[key] else { return nil }
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw PhoneCalendarCommand.invalid("Invalid \(key)")
        }
        return number.boolValue
    }
}
