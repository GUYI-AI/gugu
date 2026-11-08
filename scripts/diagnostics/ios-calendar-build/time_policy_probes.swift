import Foundation

@main struct TimePolicyProbes {
    enum ProbeError: Error, Equatable { case rejectedExpectation, failedRead, failedAction }
    static func main() throws {
        var results: [[String: Any]] = []
        func probe(_ name: String, issued: Double = 0, deadline: Double = 20, stop: Double = 100,
                   verified: Double = 9, initialNow: Double = 10, afterRead: Double? = nil,
                   reject: Bool, expectedError: RuntimeUITimePolicy.Rejected? = nil,
                   loadThrows: Bool = false, actionThrows: Bool = false) throws {
            var trace: [String] = [], calls = 0, clockCalls = 0, now = initialNow
            var failed = false
            var observedError: Error?
            do {
                try RuntimeUITimePolicy.perform(issuedAt: issued, deadline: deadline, hardStop: stop,
                    readVerifiedState: {
                        trace.append("read")
                        if loadThrows { throw ProbeError.failedRead }
                        if let afterRead { now = afterRead }
                        return verified
                    }, clock: { trace.append("clock"); clockCalls += 1; return now }, action: {
                        trace.append("action"); calls += 1
                        if actionThrows { throw ProbeError.failedAction }
                    })
            } catch { failed = true; observedError = error }
            if let expectedError {
                guard (observedError as? RuntimeUITimePolicy.Rejected) == expectedError else { throw ProbeError.rejectedExpectation }
            }
            if loadThrows { guard (observedError as? ProbeError) == .failedRead else { throw ProbeError.rejectedExpectation } }
            if actionThrows { guard (observedError as? ProbeError) == .failedAction else { throw ProbeError.rejectedExpectation } }
            guard failed == reject else { throw ProbeError.rejectedExpectation }
            if reject && !actionThrows { guard calls == 0 else { throw ProbeError.rejectedExpectation } }
            else { guard calls == 1 else { throw ProbeError.rejectedExpectation } }
            guard clockCalls == (loadThrows ? 0 : 1), trace.first == "read" else { throw ProbeError.rejectedExpectation }
            if !reject { guard trace == ["read", "clock", "action"] else { throw ProbeError.rejectedExpectation } }
            results.append(["name": name, "passed": true, "actions": calls, "clockSamples": clockCalls, "trace": trace])
        }
        try probe("valid action follows final read and clock", reject: false)
        try probe("read crosses command deadline", verified: 21, afterRead: 21, reject: true, expectedError: .expired)
        try probe("read crosses global stop", stop: 20, verified: 21, afterRead: 21, reject: true, expectedError: .expired)
        try probe("read makes lease stale", verified: 0, reject: true, expectedError: .staleLease)
        try probe("exact command deadline refuses action", verified: 20, afterRead: 20, reject: true, expectedError: .expired)
        try probe("21 second command refused despite short remaining time", issued: 0, deadline: 21, initialNow: 10, reject: true, expectedError: .invalidDuration)
        try probe("future issue time refused", issued: 11, deadline: 20, reject: true, expectedError: .expired)
        try probe("future lease timestamp refused", verified: 11, reject: true, expectedError: .staleLease)
        try probe("nonfinite command timestamp refused", issued: .nan, reject: true, expectedError: .invalidDuration)
        try probe("failed read never samples clock or invokes action", reject: true, loadThrows: true)
        try probe("action failure propagates without replay", reject: true, actionThrows: true)
        try probe("command deadline may equal global stop", stop: 20, reject: false)
        try probe("lease age below eight seconds accepted", verified: 2.001, reject: false)
        try probe("lease age exactly eight seconds refused", verified: 2, reject: true, expectedError: .staleLease)
        var stopRejected = false
        do { try RuntimeUITimePolicy.checkLease(now: 21, hardStop: 20, verifiedAt: 21) }
        catch let error as RuntimeUITimePolicy.Rejected { stopRejected = error == .expired }
        guard stopRejected else { throw ProbeError.rejectedExpectation }
        results.append(["name": "global stop independently rejects a fresh lease", "passed": true, "actions": 0])
        let out: [String: Any] = ["surface": "CLT uses the exact time-policy source also registered in UI target",
            "actualUIActions": 0, "simulators": 0, "cases": results]
        let bytes = try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: bytes, as: UTF8.self))
    }
}
