// 密码保险箱:看明文前验证本人。系统自带的验证框,能用指纹就指纹,不能用就输这台 Mac 的登录密码。
import Foundation
import LocalAuthentication

func registerOwnerAuth(_ r: Router) {
    /// { reason } → { verified: true };用户取消或失败抛 cancelled。
    r.on("owner.verify") { p in
        let reason = p.string("reason") ?? "查看已保存的密码"
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            throw HelperError(code: "unsupported", message: error?.localizedDescription ?? "这台 Mac 不能验证本人")
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            guard ok else { throw HelperError(code: "cancelled", message: "未通过验证") }
            return ["verified": true]
        } catch let failure as HelperError {
            throw failure
        } catch {
            throw HelperError(code: "cancelled", message: "未通过验证")
        }
    }
}
