package app.gugu.chat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "GuguNotificationChannels")
public class GuguNotificationChannelsPlugin extends Plugin {
    // Android keeps the original behavior of a registered ID. The old quiet channel was LOW.
    static final String QUIET_CHANNEL_ID = "gugu-alerts-quiet-v2";

    @PluginMethod
    public void ensureQuietChannel(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.isEmpty()) {
            call.reject("Notification channel name is required");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.unavailable();
            return;
        }
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null) {
            call.unavailable();
            return;
        }
        manager.createNotificationChannel(quietChannel(name));
        JSObject result = new JSObject();
        result.put("id", QUIET_CHANNEL_ID);
        call.resolve(result);
    }

    static NotificationChannel quietChannel(String name) {
        NotificationChannel channel = new NotificationChannel(
                QUIET_CHANNEL_ID, name, NotificationManager.IMPORTANCE_HIGH);
        // An omitted sound in Capacitor's createChannel keeps the system default.
        channel.setSound(null, null);
        channel.enableVibration(true);
        return channel;
    }

    @PluginMethod
    public void readStatus(PluginCall call) {
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null) {
            call.unavailable();
            return;
        }
        JSObject status = new JSObject();
        status.put("enabled", manager.areNotificationsEnabled());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = manager.getNotificationChannel(channelId(call));
            if (channel != null) status.put("importance", channel.getImportance());
        }
        call.resolve(status);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        String appPackage = getContext().getPackageName();
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + appPackage));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            String id = channelId(call);
            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            boolean channelExists = manager != null && manager.getNotificationChannel(id) != null;
            if (!call.getBoolean("appWide", false) && channelExists) {
                intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_CHANNEL_ID, id);
            } else {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            }
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, appPackage);
        }
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException exception) {
            call.reject("Notification settings are unavailable", exception);
        }
    }

    private static String channelId(PluginCall call) {
        return call.getBoolean("silent", false) ? QUIET_CHANNEL_ID : call.getString("alertChannelId", "");
    }
}
