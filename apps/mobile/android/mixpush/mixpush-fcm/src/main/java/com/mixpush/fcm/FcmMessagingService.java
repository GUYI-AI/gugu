package com.mixpush.fcm;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.mixpush.core.MixPushClient;

public final class FcmMessagingService extends FirebaseMessagingService {
    @Override public void onCreate() { FirebaseApp.initializeApp(this); super.onCreate(); }
    @Override public void onNewToken(String token) { MixPushClient.getInstance().tokenChanged(this, "fcm", token); }
    // In foreground, the existing app outlet owns presentation. The FCM SDK
    // displays notification messages in background without starting this process.
    @Override public void onMessageReceived(RemoteMessage message) { }
}
