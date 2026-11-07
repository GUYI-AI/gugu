#if os(iOS)
import CryptoKit
import Foundation
#if canImport(GuguPhoneCalendar)
import GuguPhoneCalendar
#endif

/// App-target adapter to the host's v1 contract. Core files may be linked as a package or target sources.
final class GuguCalendarExecutor: GuguNativeToolExecutor {
    private let service: PhoneCalendarService
    private let calendarEnabled: () throws -> Bool
    private let queue = DispatchQueue(label: "app.gugu.calendar-tools", qos: .utility)
    private let methods = [
        "calendar.events.list": "calendarList", "calendar.events.create": "calendarCreate",
        "calendar.events.update": "calendarUpdate", "calendar.events.delete": "calendarDelete",
    ]

    init(service: PhoneCalendarService, calendarEnabled: @escaping () throws -> Bool) {
        self.service = service
        self.calendarEnabled = calendarEnabled
    }

    private func access(_ control: GuguNativeToolControl) -> PhoneCalendarAccess {
        PhoneCalendarAccess(check: {
            try control.checkActive()
            guard try self.calendarEnabled() else {
                throw GuguHostFailure(code: "not_granted", message: "Calendar is not connected for this owner and installation")
            }
        }, beginWrite: { try control.beginMutation() }, finishWrite: { try control.finishMutation($0) })
    }

    /// Host calls this before releasing any saved calendar receipt, including a successful delete.
    func validateAccess(_ control: GuguNativeToolControl) throws {
        try service.validateAccess(access(control))
    }

    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl,
                 completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            do {
                try self.validateAccess(control)
                guard let method = self.methods[request.actionName] else {
                    throw GuguHostFailure(code: "unknown_action", message: "Unsupported calendar action")
                }
                guard let bytes = request.argumentsJSON.data(using: .utf8),
                      SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == request.argumentsSHA256 else {
                    throw GuguHostFailure(code: "invalid_args", message: "Calendar arguments do not match the admitted payload")
                }
                let decoded: Any
                do { decoded = try JSONSerialization.jsonObject(with: bytes) }
                catch { throw GuguHostFailure(code: "invalid_args", message: "Calendar arguments could not be decoded") }
                guard let arguments = decoded as? [String: Any] else {
                    throw GuguHostFailure(code: "invalid_args", message: "Calendar arguments must be an object")
                }
                let data = try self.service.execute(method: method, arguments: arguments, access: self.access(control))
                completion(["ok": true, "data": data])
            } catch let failure as GuguHostFailure {
                completion(failure.envelope)
            } catch let failure as PhoneCalendarFailure {
                completion(["ok": false, "code": failure.code, "message": failure.message])
            } catch {
                completion(["ok": false, "code": "execution_failed", "message": "Calendar operation failed"])
            }
        }
    }
}
#endif
