#if os(iOS)
import EventKit
import Foundation
import UIKit

/// Owns a single EventKit store. All data operations run on PhoneCalendarService's serial boundary.
public final class EventKitPhoneCalendarStore: PhoneCalendarStore {
    private let events: EKEventStore
    private let allowedCalendarIDs: Set<String>?

    public init() {
        events = EKEventStore()
        allowedCalendarIDs = nil
    }

    #if DEBUG && targetEnvironment(simulator)
    init(events: EKEventStore, fixtureCalendarID: String) {
        self.events = events
        allowedCalendarIDs = [fixtureCalendarID]
    }
    #endif

    public var timezone: TimeZone { .current }

    public var authorization: PhoneCalendarAuthorization {
        let state = EKEventStore.authorizationStatus(for: .event)
        if #available(iOS 17.0, *) {
            if state == .fullAccess { return .fullAccess }
            if state == .writeOnly { return .writeOnly }
        } else if state == .authorized { return .fullAccess }
        switch state {
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        case .denied: return .denied
        default: return .denied
        }
    }

    /// Only the foreground native owner connection UI calls this. Never registered as an agent tool.
    public func requestAccessFromOwnerUI(checkOwner: @escaping () throws -> Void,
                                         completion: @escaping (Result<PhoneCalendarAuthorization, Error>) -> Void) {
        DispatchQueue.main.async {
            do {
                try checkOwner()
                guard UIApplication.shared.applicationState == .active else {
                    throw PhoneCalendarFailure("not_granted", "Connect Calendar from the foreground app")
                }
                let done: (Bool, Error?) -> Void = { _, error in
                    DispatchQueue.main.async {
                        do {
                            try checkOwner()
                            if let error { throw error }
                            completion(.success(self.authorization))
                        } catch { completion(.failure(error)) }
                    }
                }
                if #available(iOS 17.0, *) { self.events.requestFullAccessToEvents(completion: done) }
                else { self.events.requestAccess(to: .event, completion: done) }
            } catch { completion(.failure(error)) }
        }
    }

    private func requireAccess() throws {
        guard authorization == .fullAccess else {
            throw PhoneCalendarFailure("os_permission", "Calendar read/write access is not granted")
        }
    }

    private func inScope(_ calendar: EKCalendar) -> Bool {
        allowedCalendarIDs?.contains(calendar.calendarIdentifier) ?? true
    }

    public func read(start: Int64, end: Int64, limit: Int, checkpoint: @escaping () throws -> Void) throws -> [PhoneCalendarEvent] {
        try requireAccess()
        let calendars = events.calendars(for: .event).filter(inScope)
        // Passing nil would accidentally search every calendar in a fixture run.
        guard !calendars.isEmpty else { try checkpoint(); return [] }
        var collected: [String: PhoneCalendarEvent] = [:]
        for window in try PhoneCalendarDates.queryWindows(start: start, end: end) {
            try checkpoint()
            try requireAccess()
            let predicate = events.predicateForEvents(withStart: window.start, end: window.end, calendars: calendars)
            // Enumeration permits cancellation and revocation checks while materializing a large range.
            var stopped: Error?
            events.enumerateEvents(matching: predicate) { event, stop in
                do {
                    try checkpoint()
                    try self.requireAccess()
                    guard let calendar = event.calendar, let startDate = event.startDate, let endDate = event.endDate else {
                        throw PhoneCalendarFailure("execution_failed", "Calendar returned incomplete event data")
                    }
                    guard self.inScope(calendar) else { return }
                    let from = Int64((startDate.timeIntervalSince1970 * 1000).rounded())
                    let until = Int64((endDate.timeIntervalSince1970 * 1000).rounded())
                    guard from < end && until > start else { return }
                    guard let id = event.eventIdentifier, !id.isEmpty else {
                        throw PhoneCalendarFailure("execution_failed", "Calendar returned an event without an identifier")
                    }
                    let record = PhoneCalendarEvent(eventID: id, title: event.title ?? "",
                        startMS: event.isAllDay ? try PhoneCalendarDates.utcDateMS(fromLocalDay: startDate, timezone: self.timezone) : from,
                        endMS: event.isAllDay ? try PhoneCalendarDates.utcDateMS(fromLocalDay: endDate, timezone: self.timezone) : until,
                        allDay: event.isAllDay, location: event.location ?? "", notes: event.notes ?? "",
                        calendarName: calendar.title, calendarID: calendar.calendarIdentifier)
                    // A recurring event's identifier is shared; keep separate occurrences.
                    collected["\(id):\(from):\(until)"] = record
                    if collected.count > limit,
                       let last = collected.max(by: { left, right in
                           if left.value.startMS != right.value.startMS { return left.value.startMS < right.value.startMS }
                           return left.value.eventID < right.value.eventID
                       }) { collected.removeValue(forKey: last.key) }
                } catch {
                    stopped = error
                    stop.pointee = true
                }
            }
            if let stopped { throw stopped }
            try checkpoint()
            if collected.count >= limit { break }
        }
        try requireAccess()
        return Array(collected.values.sorted {
            if $0.startMS != $1.startMS { return $0.startMS < $1.startMS }
            return $0.eventID < $1.eventID
        }.prefix(limit))
    }

    private func writableCalendar(_ requested: String?) throws -> EKCalendar {
        let calendars = events.calendars(for: .event).filter { inScope($0) && $0.allowsContentModifications }
        if let requested {
            guard let calendar = calendars.first(where: { $0.calendarIdentifier == requested }) else {
                throw PhoneCalendarFailure("unavailable", "The selected calendar is not writable")
            }
            return calendar
        }
        if let preferred = events.defaultCalendarForNewEvents,
           let calendar = calendars.first(where: { $0.calendarIdentifier == preferred.calendarIdentifier }) { return calendar }
        guard let calendar = calendars.first else { throw PhoneCalendarFailure("unavailable", "No writable calendar is available") }
        return calendar
    }

    private func writableEvent(_ id: String) throws -> EKEvent {
        guard let event = events.event(withIdentifier: id) else {
            throw PhoneCalendarFailure("invalid_args", "Calendar event was not found")
        }
        guard let calendar = event.calendar else { throw PhoneCalendarFailure("execution_failed", "Calendar returned an event without its calendar") }
        guard inScope(calendar) else { throw PhoneCalendarFailure("not_granted", "Calendar is outside the selected scope") }
        guard calendar.allowsContentModifications else { throw PhoneCalendarFailure("unavailable", "Calendar is read-only") }
        guard !event.hasRecurrenceRules && !event.isDetached else {
            throw PhoneCalendarFailure("unsupported_recurrence_scope", "Editing or deleting the entire recurring series has not been verified on iOS")
        }
        return event
    }

    public func prepare(_ command: PhoneCalendarCommand) throws -> PhoneCalendarPreparedWrite {
        try requireAccess()
        switch command {
        case let .create(input):
            let event = EKEvent(eventStore: events)
            event.calendar = try writableCalendar(input.calendarID)
            event.title = input.title
            event.isAllDay = input.allDay
            event.startDate = input.allDay
                ? try PhoneCalendarDates.localDay(fromUTCDateMS: input.startMS, timezone: timezone)
                : Date(timeIntervalSince1970: Double(input.startMS) / 1000)
            event.endDate = input.allDay
                ? try PhoneCalendarDates.localDay(fromUTCDateMS: input.endMS, timezone: timezone)
                : Date(timeIntervalSince1970: Double(input.endMS) / 1000)
            event.timeZone = timezone
            event.location = input.location
            event.notes = input.notes
            if let minutes = input.reminderMinutes { event.addAlarm(EKAlarm(relativeOffset: -Double(minutes) * 60)) }
            return PhoneCalendarPreparedWrite {
                try self.requireAccess()
                try self.events.save(event, span: .thisEvent, commit: true)
                guard let id = event.eventIdentifier else {
                    throw PhoneCalendarFailure("execution_unknown", "Calendar saved without returning an identifier", writeMayHaveCommitted: true)
                }
                return ["event_id": id, "calendar_id": event.calendar.calendarIdentifier]
            }
        case let .update(input):
            let event = try writableEvent(input.eventID)
            guard let existingStart = event.startDate, let existingEnd = event.endDate else {
                throw PhoneCalendarFailure("execution_failed", "Calendar returned invalid event dates")
            }
            let start = input.startMS.map { Date(timeIntervalSince1970: Double($0) / 1000) } ?? existingStart
            let end = input.endMS.map { Date(timeIntervalSince1970: Double($0) / 1000) } ?? existingEnd
            guard end > start else { throw PhoneCalendarFailure("invalid_args", "Updated end must be after start") }
            return PhoneCalendarPreparedWrite {
                try self.requireAccess()
                if let title = input.title { event.title = title }
                if input.startMS != nil { event.startDate = start }
                if input.endMS != nil { event.endDate = end }
                if let location = input.location { event.location = location }
                if let notes = input.notes { event.notes = notes }
                try self.events.save(event, span: .thisEvent, commit: true)
                return ["event_id": event.eventIdentifier ?? input.eventID]
            }
        case let .delete(id):
            let event = try writableEvent(id)
            return PhoneCalendarPreparedWrite {
                try self.requireAccess()
                try self.events.remove(event, span: .thisEvent, commit: true)
                return ["event_id": id]
            }
        case .list:
            throw PhoneCalendarFailure("invalid_args", "A read cannot be prepared as a mutation")
        }
    }
}
#endif
