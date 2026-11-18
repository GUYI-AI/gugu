package app.gugu.chat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;

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
}
