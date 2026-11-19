package app.gugu.chat;

import android.content.pm.ActivityInfo;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Only the Activity is rotated. No global settings or other applications are changed. */
@CapacitorPlugin(name = "GuguWatchOrientation")
public class GuguWatchOrientation extends Plugin {
    private WatchOrientationLease lease;
    private boolean destroyed;

    private WatchOrientationLease lease() {
        if (lease == null) lease = new WatchOrientationLease(new WatchOrientationLease.Window() {
            public int requested() { return getActivity().getRequestedOrientation(); }
            public void request(int orientation) { getActivity().setRequestedOrientation(orientation); }
        });
        return lease;
    }

    @PluginMethod public void set(PluginCall call) {
        String id = call.getString("id");
        String orientation = call.getString("orientation");
        if (id == null || !id.matches("[A-Za-z0-9_-]{8,128}")
                || !("landscape".equals(orientation) || "portrait".equals(orientation))) {
            call.reject("a viewer id and portrait or landscape orientation are required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (destroyed) { call.reject("the viewing activity was destroyed"); return; }
            lease().set(id, "landscape".equals(orientation)
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
            call.resolve();
        });
    }

    @PluginMethod public void release(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("a viewer id is required"); return; }
        getActivity().runOnUiThread(() -> call.resolve(new JSObject().put("released", lease != null && lease.release(id))));
    }

    @Override protected void handleOnDestroy() {
        destroyed = true;
        getActivity().runOnUiThread(() -> { if (lease != null) lease.restore(); });
    }
}
