package app.gugu.chat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import app.gugu.chat.push.PushChannelSelector;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.mixpush.core.BaseMixPushProvider;
import com.mixpush.core.MixPushClient;
import com.mixpush.core.MixPushMessage;
import com.mixpush.core.MixPushPlatform;
import com.mixpush.core.MixPushReceiver;
import java.util.Collections;

@CapacitorPlugin(name = "GuguAndroidPush")
public final class GuguAndroidPushPlugin extends Plugin {
    private static final String OPEN = "app.gugu.chat.OPEN_PUSH";
    private long epoch;
    private String owner;
    private BaseMixPushProvider provider;
    @Override public void load() {
        MixPushClient.getInstance().setPushReceiver(new MixPushReceiver() {
            @Override public void onRegisterSucceed(Context context, MixPushPlatform platform) {
                if (owner != null && "fcm".equals(platform.getPlatformName()))
                    notifyListeners("tokenChanged", new JSObject(), true);
            }
            @Override public void onNotificationMessageClicked(Context context, MixPushMessage message) { }
        });
        opened(getActivity().getIntent());
    }
    private BaseMixPushProvider available() throws Exception {
        if (!BuildConfig.GUGU_FCM_ENABLED) return null;
        BaseMixPushProvider candidate = (BaseMixPushProvider) Class.forName("com.mixpush.fcm.FcmPushProvider").getDeclaredConstructor().newInstance();
        return candidate.isSupport(getContext()) ? candidate : null;
    }
    private JSObject binding(PluginCall call) throws Exception {
        String canonical = GuguAgentHostPolicy.owner(call.getString("ownerId"));
        String installation = GuguPhoneRegistration.resolve(getContext(), GuguPhoneInstallation.identity(getContext()), canonical, call.getString("cachedId"), call.getString("cachedBinding"));
        return new JSObject().put("ownerId", canonical).put("installationId", installation)
            .put("deviceId", "phone-" + installation + "-" + canonical);
    }
    @PluginMethod public void status(PluginCall call) {
        try {
            BaseMixPushProvider candidate = available();
            String selected = PushChannelSelector.select(Build.MANUFACTURER,
                candidate == null ? Collections.emptySet() : Collections.singleton("fcm"), candidate != null);
            JSObject result = binding(call);
            result.put("provider", selected == null ? JSObject.NULL : selected)
                .put("topic", getContext().getPackageName()).put("environment", "production")
                .put("allowed", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
            call.resolve(result);
        } catch (Exception error) { call.reject("Cannot read Android push availability"); }
    }
    @PluginMethod public void register(PluginCall call) {
        try {
            if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) throw new IllegalStateException();
            JSObject result = binding(call);
            BaseMixPushProvider selected = available();
            if (selected == null) throw new IllegalStateException();
            ensureChannels();
            owner = result.getString("ownerId"); provider = selected;
            long current = ++epoch;
            MixPushClient.getInstance().register(getContext(), selected).whenComplete((token, error) -> {
                if (error != null || current != epoch) { call.reject("Android push registration unavailable"); return; }
                result.put("provider", token.getPlatformName()).put("token", token.getRegId())
                    .put("topic", getContext().getPackageName()).put("environment", "production");
                call.resolve(result);
            });
        } catch (Exception error) { call.reject("Android push registration unavailable"); }
    }
    @PluginMethod public void revoke(PluginCall call) {
        try {
            String revokedOwner = binding(call).getString("ownerId");
            ++epoch; owner = null;
            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            if (manager != null && Build.VERSION.SDK_INT >= 23) {
                for (android.service.notification.StatusBarNotification notification : manager.getActiveNotifications()) {
                    String tag = notification.getTag();
                    if (tag != null && tag.matches("[0-9a-f-]{36}")) manager.cancel(tag, notification.getId());
                }
            }
            // #3416 Conversation notifications and shortcuts are this account's too, whatever the push provider.
            GuguChatNotificationsPlugin.clear(getContext(), revokedOwner);
            BaseMixPushProvider selected = provider != null ? provider : available();
            if (selected == null) { call.resolve(); return; }
            selected.revoke(getContext()).whenComplete((unused, error) -> {
                if (error != null) call.reject("Android push revocation unavailable"); else call.resolve();
            });
        } catch (Exception error) { call.reject("Android push revocation unavailable"); }
    }
    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null) throw new IllegalStateException("Notification channels unavailable");
        manager.createNotificationChannel(new NotificationChannel("gugu-alerts", "咕咕", NotificationManager.IMPORTANCE_HIGH));
        manager.createNotificationChannel(GuguNotificationChannelsPlugin.quietChannel("咕咕"));
    }
    private void opened(Intent intent) {
        if (intent == null || !OPEN.equals(intent.getAction())) return;
        JSObject data = new JSObject();
        for (String field : new String[] { "v", "notificationId", "ownerId", "installationId", "registrationId", "generation", "kind", "revision", "chatId", "messageId", "agentId" }) {
            String value = intent.getStringExtra(field);
            if (value != null && value.length() <= 256) data.put(field, value);
            intent.removeExtra(field);
        }
        intent.setAction(Intent.ACTION_MAIN);
        notifyListeners("opened", data, true);
    }
    @Override protected void handleOnNewIntent(Intent intent) { opened(intent); }
    @Override protected void handleOnDestroy() { ++epoch; owner = null; MixPushClient.getInstance().setPushReceiver(null); }
}
