package app.gugu.chat;

/** No credential-bearing exception/cause crosses the bridge or enters logs. */
final class AuthStorageFailure extends Exception {
    final String reason;
    final boolean recovery;
    AuthStorageFailure(String reason, boolean recovery) {
        super(recovery ? "登录信息无法读取，需要重新登录" : "请重试");
        this.reason = reason; this.recovery = recovery;
    }
}
