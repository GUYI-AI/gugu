package com.mixpush.core;

import android.content.Context;
import java.util.concurrent.CompletableFuture;

/** Adapted from MixPush. The caller selects exactly one configured provider. */
public final class MixPushClient {
    private static final MixPushClient INSTANCE = new MixPushClient();
    private BaseMixPushProvider provider;
    private MixPushReceiver receiver;
    public static MixPushClient getInstance() { return INSTANCE; }
    public synchronized void setPushReceiver(MixPushReceiver value) { receiver = value; }
    public synchronized CompletableFuture<MixPushPlatform> register(Context context, BaseMixPushProvider selected) {
        provider = selected;
        if (!selected.isSupport(context)) {
            CompletableFuture<MixPushPlatform> failed = new CompletableFuture<>();
            failed.completeExceptionally(new IllegalStateException("Push provider unavailable")); return failed;
        }
        return selected.registerNotification(context);
    }
    public synchronized CompletableFuture<Void> revoke(Context context) {
        return provider == null ? CompletableFuture.completedFuture(null) : provider.revoke(context);
    }
    public void tokenChanged(Context context, String platform, String token) {
        MixPushReceiver target;
        synchronized (this) { target = receiver; }
        if (target != null) target.onRegisterSucceed(context, new MixPushPlatform(platform, token));
    }
}
