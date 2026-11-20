package com.mixpush.core;

import android.content.Context;
import java.util.concurrent.CompletableFuture;

/** MixPush provider contract, adapted to report completion without polling. */
public abstract class BaseMixPushProvider {
    public abstract CompletableFuture<MixPushPlatform> registerNotification(Context context);
    public abstract CompletableFuture<Void> revoke(Context context);
    public abstract boolean isSupport(Context context);
    public abstract String getPlatformName();
}
