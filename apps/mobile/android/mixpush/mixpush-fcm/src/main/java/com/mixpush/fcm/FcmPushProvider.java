package com.mixpush.fcm;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.mixpush.core.BaseMixPushProvider;
import com.mixpush.core.MixPushPlatform;
import java.util.concurrent.CompletableFuture;

/** Adapted from upstream FCM module; the obsolete InstanceId API never returned a token. */
public final class FcmPushProvider extends BaseMixPushProvider {
    private static <T> CompletableFuture<T> bounded() {
        CompletableFuture<T> result = new CompletableFuture<>();
        Handler handler = new Handler(Looper.getMainLooper());
        Runnable timeout = () -> result.completeExceptionally(new IllegalStateException("FCM operation timed out"));
        handler.postDelayed(timeout, 15000);
        result.whenComplete((value, error) -> handler.removeCallbacks(timeout));
        return result;
    }
    @Override public String getPlatformName() { return "fcm"; }
    @Override public boolean isSupport(Context context) {
        return context.getResources().getIdentifier("google_app_id", "string", context.getPackageName()) != 0
            && GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS;
    }
    @Override public CompletableFuture<MixPushPlatform> registerNotification(Context context) {
        CompletableFuture<MixPushPlatform> result = bounded();
        try {
            if (FirebaseApp.initializeApp(context) == null) throw new IllegalStateException("FCM configuration unavailable");
            FirebaseMessaging messaging = FirebaseMessaging.getInstance();
            messaging.setAutoInitEnabled(true);
            messaging.getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null && !task.getResult().isEmpty())
                    result.complete(new MixPushPlatform("fcm", task.getResult()));
                else result.completeExceptionally(new IllegalStateException("FCM registration unavailable"));
            });
        } catch (Exception error) { result.completeExceptionally(new IllegalStateException("FCM registration unavailable")); }
        return result;
    }
    @Override public CompletableFuture<Void> revoke(Context context) {
        CompletableFuture<Void> result = bounded();
        try {
            if (FirebaseApp.initializeApp(context) == null) throw new IllegalStateException();
            FirebaseMessaging messaging = FirebaseMessaging.getInstance();
            messaging.setAutoInitEnabled(false);
            messaging.deleteToken().addOnCompleteListener(task -> {
                if (task.isSuccessful()) result.complete(null);
                else result.completeExceptionally(new IllegalStateException("FCM revocation unavailable"));
            });
        } catch (Exception error) { result.completeExceptionally(new IllegalStateException("FCM revocation unavailable")); }
        return result;
    }
}
