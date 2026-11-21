package app.gugu.chat;

/** No credential-bearing exception/cause crosses the bridge or enters logs. */
final class AuthStorageFailure extends Exception {
    final String reason;
    final boolean recovery;
    AuthStorageFailure(String reason, boolean recovery) {
        super(recovery ? "请联系支持恢复登录" : "请重试");
        this.reason = reason; this.recovery = recovery;
    }
}
