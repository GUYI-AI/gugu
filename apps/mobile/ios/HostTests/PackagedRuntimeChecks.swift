import Foundation
import CryptoKit

@main struct PackagedRuntimeChecks {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let manager = FileManager.default
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        var passed = [String]()
        let script = Data("var fixtureRuntime = true;".utf8)
        let digest = SHA256.hash(data: script).map { String(format: "%02x", $0) }.joined()
        func makeBundle(_ name: String, hash: String = digest, version: String = "1.4.0") throws -> (Bundle, URL) {
            let path = root.appendingPathComponent(name + ".bundle", isDirectory: true)
            let resources = path.appendingPathComponent("HostRuntime", isDirectory: true)
            try manager.createDirectory(at: resources, withIntermediateDirectories: true)
            try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "app.gugu.loader-test." + name, "CFBundlePackageType": "BNDL"], format: .xml, options: 0).write(to: path.appendingPathComponent("Info.plist"))
            try script.write(to: resources.appendingPathComponent("agent.js"))
            try JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "piVersion": version, "bytes": script.count, "sha256": hash]).write(to: resources.appendingPathComponent("manifest.json"))
            guard let bundle = Bundle(url: path) else { throw NSError(domain: "FixtureBundle", code: 1) }
            return (bundle, resources)
        }
        func rejects(_ name: String, bundle: Bundle, code: String) throws {
            do { _ = try GuguPackagedRuntime.load(bundle: bundle) }
            catch let error as GuguHostFailure where error.code == code { passed.append(name); return }
            throw NSError(domain: "ExpectedRejection." + name, code: 1)
        }
        let (valid, _) = try makeBundle("valid")
        let loaded = try GuguPackagedRuntime.load(bundle: valid)
        guard loaded.asset == script && loaded.sha256 == digest else { throw NSError(domain: "ValidBytes", code: 1) }
        passed.append("valid packaged bytes")
        let (corrupt, _) = try makeBundle("corrupt", hash: String(repeating: "0", count: 64))
        try rejects("corrupt bytes rejected", bundle: corrupt, code: "invalid_runtime_asset")
        let (wrongVersion, _) = try makeBundle("wrong-version", version: "9.9.9")
        try rejects("incompatible manifest rejected", bundle: wrongVersion, code: "invalid_runtime_manifest")
        let (escaped, escapedResources) = try makeBundle("escaped")
        let outside = root.appendingPathComponent("outside.js")
        try script.write(to: outside)
        let escapedAsset = escapedResources.appendingPathComponent("agent.js")
        try manager.removeItem(at: escapedAsset)
        try manager.createSymbolicLink(at: escapedAsset, withDestinationURL: outside)
        try rejects("external symlink rejected", bundle: escaped, code: "invalid_runtime_asset")
        let (missing, missingResources) = try makeBundle("missing")
        try manager.removeItem(at: missingResources.appendingPathComponent("manifest.json"))
        try rejects("missing manifest rejected", bundle: missing, code: "runtime_asset_missing")
        let result: [String: Any] = ["passed": passed, "count": passed.count, "scope": "macOS Foundation loader only", "realModelCalls": 0, "iosAppRuns": 0]
        print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: .sortedKeys), as: UTF8.self))
    }
}
