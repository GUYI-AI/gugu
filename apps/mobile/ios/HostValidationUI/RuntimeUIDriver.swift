#if DEBUG && os(iOS) && targetEnvironment(simulator)
import XCTest
import Foundation
import CryptoKit
import CoreFoundation
import Darwin

// Diagnostic UI target only. No authentication, EventKit or model APIs here.
@MainActor final class RuntimeUIDriver: XCTestCase {
    private struct Input: Decodable {
        let status: String
        let runID: String
        let simulatorUDID: String
        let controlRoot: String
        let deviceDataRoot: String
        let hardStopUnix: Double
        let admissionSHA256: String
        let appEnvironment: [String: String]
    }
    private enum Rejected: Error { case invalidInput, expired, leaseStale, invalidCommand, priorUncertain }
    private func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }
    private func exactBoolean(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }
    private let targets: Set<String> = ["app.gugu.chat", "com.apple.springboard", "com.apple.Preferences", "com.apple.mobilecal"]
    private func sha(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private func readVerifiedLease(_ input: Input, root: URL) throws -> Double {
        let bytes = try Data(contentsOf: root.appendingPathComponent("lease.json"))
        guard let lease = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              lease["runID"] as? String == input.runID,
              lease["admissionSHA256"] as? String == input.admissionSHA256,
              lease["simulatorUDID"] as? String == input.simulatorUDID,
              exactBoolean(lease["owned"]) == true,
              let last = number(lease["verifiedAtUnix"]),
              !FileManager.default.fileExists(atPath: root.appendingPathComponent("stop").path) else { throw Rejected.leaseStale }
        return last
    }
    private func current(_ input: Input, root: URL) throws {
        let verifiedAt = try readVerifiedLease(input, root: root)
        let now = Date().timeIntervalSince1970
        try RuntimeUITimePolicy.checkLease(now: now, hardStop: input.hardStopUnix, verifiedAt: verifiedAt)
    }
    private func write(_ value: [String: Any], _ url: URL) throws {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func testFileQueueUI() throws {
        continueAfterFailure = false
        guard let path = ProcessInfo.processInfo.environment["GUGU_A_UI_RUN_PATH"] else { throw Rejected.invalidInput }
        let bytes = try Data(contentsOf: URL(fileURLWithPath: path))
        let input = try JSONDecoder().decode(Input.self, from: bytes)
        guard input.status == "ADMITTED", UUID(uuidString: input.runID) != nil, UUID(uuidString: input.simulatorUDID) != nil,
              ProcessInfo.processInfo.environment["SIMULATOR_UDID"] == input.simulatorUDID,
              input.admissionSHA256.range(of: #"\A[0-9a-f]{64}\z"#, options: .regularExpression) != nil,
              input.hardStopUnix > Date().timeIntervalSince1970,
              input.hardStopUnix - Date().timeIntervalSince1970 <= 25 * 60,
              Set(input.appEnvironment.keys) == ["GUGU_HOME", "GUGU_USER_DATA_DIR"] else { throw Rejected.invalidInput }
        let root = URL(fileURLWithPath: input.controlRoot).standardizedFileURL
        let resolved = root.resolvingSymlinksInPath()
        let runnerHome = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.resolvingSymlinksInPath()
        var cursor = runnerHome
        var actualDeviceData: URL?
        while cursor.path != "/" {
            if cursor.lastPathComponent == "data",
               cursor.deletingLastPathComponent().lastPathComponent == input.simulatorUDID,
               cursor.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "Devices" {
                actualDeviceData = cursor; break
            }
            cursor.deleteLastPathComponent()
        }
        guard let deviceData = actualDeviceData,
              runnerHome.path.hasPrefix(deviceData.appendingPathComponent("Containers/Data/Application").path + "/"),
              URL(fileURLWithPath: input.deviceDataRoot).standardizedFileURL.path == deviceData.path,
              root.path == resolved.path,
              root.path == deviceData.appendingPathComponent("GuguAUI").appendingPathComponent(input.runID).path,
              try String(contentsOf: root.appendingPathComponent("run.marker"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) == input.runID else { throw Rejected.invalidInput }
        let attrs = try FileManager.default.attributesOfItem(atPath: root.path)
        guard (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              (attrs[.posixPermissions] as? NSNumber)?.intValue == 0o700 else { throw Rejected.invalidInput }
        guard Set(input.appEnvironment.values).count == 2 else { throw Rejected.invalidInput }
        for value in input.appEnvironment.values {
            let url = URL(fileURLWithPath: value).standardizedFileURL
            guard url.path == url.resolvingSymlinksInPath().path,
                  url.path.hasPrefix(root.path + "/app-data/") else { throw Rejected.invalidInput }
            let item = try FileManager.default.attributesOfItem(atPath: url.path)
            guard (item[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                  (item[.posixPermissions] as? NSNumber)?.intValue == 0o700,
                  item[.type] as? FileAttributeType == .typeDirectory else { throw Rejected.invalidInput }
        }
        guard !(try FileManager.default.contentsOfDirectory(atPath: root.path)).contains(where: { $0.hasPrefix("inflight-") }) else { throw Rejected.priorUncertain }
        let app = XCUIApplication(bundleIdentifier: "app.gugu.chat")
        // Set the final child values before its first launch; never setenv in the App.
        app.launchEnvironment = input.appEnvironment
        var launched = false
        try write(["runID": input.runID, "simulatorUDID": input.simulatorUDID,
                   "driverPID": ProcessInfo.processInfo.processIdentifier,
                   "appLaunched": false, "actualDeviceDataRoot": deviceData.path,
                   "actualRunnerHome": runnerHome.path, "inputSHA256": sha(bytes)], root.appendingPathComponent("ready.json"))
        while Date().timeIntervalSince1970 < input.hardStopUnix {
            try current(input, root: root)
            let next = root.appendingPathComponent("command.json")
            guard FileManager.default.fileExists(atPath: next.path) else { Thread.sleep(forTimeInterval: 0.2); continue }
            let commandBytes = try Data(contentsOf: next)
            guard commandBytes.count <= 16384,
                  let c = try JSONSerialization.jsonObject(with: commandBytes) as? [String: Any],
                  let id = c["id"] as? String, UUID(uuidString: id) != nil,
                  c["runID"] as? String == input.runID,
                  let issuedAt = number(c["issuedAtUnix"]),
                  let deadline = number(c["expiresAtUnix"]), deadline <= input.hardStopUnix,
                  deadline > issuedAt, deadline - issuedAt <= 20,
                  let action = c["action"] as? String,
                  let bundle = c["bundle"] as? String, targets.contains(bundle),
                  Set(c.keys).isSubset(of: ["id", "runID", "issuedAtUnix", "expiresAtUnix", "action", "bundle", "kind", "label", "index", "text"]) else { throw Rejected.invalidCommand }
            let inflight = root.appendingPathComponent("inflight-\(id).json")
            let receipt = root.appendingPathComponent("result-\(id).json")
            guard !FileManager.default.fileExists(atPath: receipt.path) else { throw Rejected.invalidCommand }
            try FileManager.default.moveItem(at: next, to: inflight)
            var result: [String: Any] = ["id": id, "runID": input.runID, "ok": true,
                "commandSHA256": sha(commandBytes), "issuedAtUnix": issuedAt,
                "expiresAtUnix": deadline, "startedAtUnix": Date().timeIntervalSince1970]
            let target = bundle == "app.gugu.chat" ? app : XCUIApplication(bundleIdentifier: bundle)
            func performAction(_ body: () throws -> Void) throws {
                try RuntimeUITimePolicy.perform(issuedAt: issuedAt, deadline: deadline,
                    hardStop: input.hardStopUnix, readVerifiedState: {
                        guard sha(try Data(contentsOf: URL(fileURLWithPath: path))) == sha(bytes),
                              let barrier = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("unresolved.json"))) as? [String: Any],
                              barrier["id"] as? String == id,
                              barrier["runID"] as? String == input.runID,
                              barrier["commandSHA256"] as? String == sha(commandBytes),
                              barrier["state"] as? String == "admitted" else { throw Rejected.expired }
                        return try readVerifiedLease(input, root: root)
                    }, action: body)
            }
            switch action {
            case "launch":
                guard bundle == "app.gugu.chat", !launched else { throw Rejected.invalidCommand }
                try performAction { app.launch() }; launched = true
            case "activate":
                guard bundle != "app.gugu.chat" || launched else { throw Rejected.invalidCommand }
                try performAction { target.activate() }
            case "home": try performAction { XCUIDevice.shared.press(.home) }
            case "tree":
                var description = ""
                try performAction { description = target.debugDescription }
                let tree = Data(description.utf8)
                let treeURL = root.appendingPathComponent("tree-\(id).private.txt")
                try tree.write(to: treeURL, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: treeURL.path)
                result["treeSHA256"] = sha(tree); result["treeBytes"] = tree.count
            case "screenshot":
                // The device screen includes system alerts; never silently screenshot another target.
                var image: XCUIScreenshot?
                try performAction { image = XCUIScreen.main.screenshot() }
                guard let image else { throw Rejected.invalidCommand }
                let shot = XCTAttachment(screenshot: image)
                shot.name = "owned-ui-\(id)"; shot.lifetime = .keepAlways; add(shot)
            case "tap", "type":
                guard let label = c["label"] as? String, !label.isEmpty, label.count <= 256,
                      let kind = c["kind"] as? String,
                      let indexValue = number(c["index"]), indexValue.rounded() == indexValue, indexValue >= 0, indexValue <= 50 else { throw Rejected.invalidCommand }
                let index = Int(indexValue)
                var selected: XCUIElement?
                try performAction {
                    let query: XCUIElementQuery
                    switch kind {
                    case "button": query = target.buttons
                    case "textField": query = target.textFields
                    case "secureTextField": query = target.secureTextFields
                    case "textView": query = target.textViews
                    case "staticText": query = target.staticTexts
                    case "cell": query = target.cells
                    default: throw Rejected.invalidCommand
                    }
                    selected = query.matching(NSPredicate(format: "label == %@ OR identifier == %@", label, label)).element(boundBy: index)
                }
                guard let exact = selected else { throw Rejected.invalidCommand }
                let wait = min(5, max(0, deadline - Date().timeIntervalSince1970))
                var exists = false
                try performAction { exists = exact.waitForExistence(timeout: wait) }
                guard exists else { throw Rejected.invalidCommand }
                if action == "tap" { try performAction { exact.tap() } }
                else {
                    guard let text = c["text"] as? String, !text.isEmpty, text.count <= 4000,
                          ["textField", "secureTextField", "textView"].contains(kind) else { throw Rejected.invalidCommand }
                    try performAction { exact.typeText(text) }; result["typedCharacterCount"] = text.count
                }
            case "swipeUp": try performAction { target.swipeUp() }
            case "swipeDown": try performAction { target.swipeDown() }
            case "stop": try performAction {}
            default: throw Rejected.invalidCommand
            }
            result["finishedAtUnix"] = Date().timeIntervalSince1970
            result["completedBeforeDeadline"] = Date().timeIntervalSince1970 < deadline
            // A known result remains recorded after an action; only the client may explicitly acknowledge its unresolved intent.
            try write(result, receipt)
            try FileManager.default.removeItem(at: inflight)
            if action == "stop" { return }
            try current(input, root: root)
        }
        throw Rejected.expired
    }
}
#endif
