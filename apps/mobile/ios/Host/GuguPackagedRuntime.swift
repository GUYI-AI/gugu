import Foundation
import CryptoKit

/// Loads only the immutable runtime shipped with this App, never a downloaded replacement.
struct GuguPackagedRuntime {
    let asset: Data
    let sha256: String
    let piVersion: String

    static func load(bundle: Bundle = .main) throws -> GuguPackagedRuntime {
        guard let manifestURL = bundle.url(forResource: "manifest", withExtension: "json", subdirectory: "HostRuntime"),
              let assetURL = bundle.url(forResource: "agent", withExtension: "js", subdirectory: "HostRuntime"),
              let resourceURL = bundle.resourceURL else {
            throw GuguHostFailure(code: "runtime_asset_missing", message: "手机本机运行组件缺失，请更新应用。")
        }
        let resourcePath = resourceURL.resolvingSymlinksInPath().standardizedFileURL.path + "/"
        guard manifestURL.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(resourcePath),
              assetURL.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(resourcePath) else {
            throw GuguHostFailure(code: "invalid_runtime_asset", message: "本机运行组件不属于当前应用。")
        }
        let manifestData = try Data(contentsOf: manifestURL)
        guard let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              manifest["protocolVersion"] as? Int == 1,
              let piVersion = manifest["piVersion"] as? String, piVersion == "1.4.0",
              let expected = manifest["sha256"] as? String,
              expected.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              let expectedBytes = manifest["bytes"] as? Int else {
            throw GuguHostFailure(code: "invalid_runtime_manifest", message: "本机运行组件清单不兼容，请更新应用。")
        }
        let asset = try Data(contentsOf: assetURL)
        let actual = SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined()
        guard asset.count == expectedBytes, actual == expected else {
            throw GuguHostFailure(code: "invalid_runtime_asset", message: "本机运行组件校验失败，请重新安装应用。")
        }
        return GuguPackagedRuntime(asset: asset, sha256: actual, piVersion: piVersion)
    }
}
