#if DEBUG && os(iOS) && targetEnvironment(simulator)
import EventKit
import Foundation

/// Test infrastructure only. No fixture symbols or calendar-creation entry point in Release/device builds.
public final class PhoneCalendarSimulatorFixture {
    public struct Manifest: Codable {
        public let runID: String
        public let calendarIdentifier: String
        public let title: String
        public let sourceIdentifier: String
    }

    public let manifest: Manifest
    private let eventStore: EKEventStore

    private init(manifest: Manifest, eventStore: EKEventStore) {
        self.manifest = manifest
        self.eventStore = eventStore
    }

    /// Call after explicit permission setup on a line-owned, signed-out simulator. This never prompts.
    public static func open(manifestURL: URL) throws -> PhoneCalendarSimulatorFixture {
        let store = EKEventStore()
        let allowed: Bool
        if #available(iOS 17.0, *) { allowed = EKEventStore.authorizationStatus(for: .event) == .fullAccess }
        else { allowed = EKEventStore.authorizationStatus(for: .event) == .authorized }
        guard allowed else { throw PhoneCalendarFailure("os_permission", "Grant Calendar access before preparing the simulator fixture") }
        if FileManager.default.fileExists(atPath: manifestURL.path) {
            let saved = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
            let fixture = PhoneCalendarSimulatorFixture(manifest: saved, eventStore: store)
            _ = try fixture.calendar()
            return fixture
        }
        guard let source = store.sources.first(where: { $0.sourceType == .local }) else {
            throw PhoneCalendarFailure("unavailable", "The isolated simulator needs a local calendar source; no account source will be used")
        }
        let runID = UUID().uuidString.lowercased()
        let title = "Gugu iOS Fixture \(runID)"
        let calendar = EKCalendar(for: .event, eventStore: store)
        calendar.title = title
        calendar.source = source
        try store.saveCalendar(calendar, commit: true)
        let manifest = Manifest(runID: runID, calendarIdentifier: calendar.calendarIdentifier,
                                title: title, sourceIdentifier: source.sourceIdentifier)
        do {
            try FileManager.default.createDirectory(at: manifestURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(manifest).write(to: manifestURL, options: [.atomic, .completeFileProtection])
            var protectedURL = manifestURL
            var resources = URLResourceValues()
            resources.isExcludedFromBackup = true
            try protectedURL.setResourceValues(resources)
        } catch {
            // Only remove the exact calendar just created by this invocation.
            try? store.removeCalendar(calendar, commit: true)
            throw error
        }
        return PhoneCalendarSimulatorFixture(manifest: manifest, eventStore: store)
    }

    private func calendar() throws -> EKCalendar {
        guard UUID(uuidString: manifest.runID) != nil,
              manifest.title == "Gugu iOS Fixture \(manifest.runID)",
              let calendar = eventStore.calendar(withIdentifier: manifest.calendarIdentifier),
              calendar.title == manifest.title,
              calendar.source.sourceType == .local,
              calendar.source.sourceIdentifier == manifest.sourceIdentifier else {
            throw PhoneCalendarFailure("not_granted", "Fixture manifest does not identify this line's local calendar")
        }
        return calendar
    }

    public func makeStore() throws -> EventKitPhoneCalendarStore {
        _ = try calendar()
        return EventKitPhoneCalendarStore(events: eventStore, fixtureCalendarID: manifest.calendarIdentifier)
    }

    public func remove(manifestURL: URL) throws {
        let saved = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
        guard saved.runID == manifest.runID, saved.calendarIdentifier == manifest.calendarIdentifier else {
            throw PhoneCalendarFailure("not_granted", "Refusing to clean a different fixture")
        }
        try eventStore.removeCalendar(try calendar(), commit: true)
        try FileManager.default.removeItem(at: manifestURL)
    }
}
#endif
