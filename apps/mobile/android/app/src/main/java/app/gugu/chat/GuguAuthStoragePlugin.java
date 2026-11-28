package app.gugu.chat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "GuguAuthStorage")
public class GuguAuthStoragePlugin extends Plugin {
    static final Object STORAGE_LOCK = new Object();
    private static void reject(PluginCall call, Exception error) {
        if (error instanceof AuthStorageFailure) {
            AuthStorageFailure failure = (AuthStorageFailure) error;
            call.reject(failure.getMessage(), "closure_recovery_pending".equals(failure.reason) ? "auth_storage_closure_pending"
                : failure.recovery ? "auth_storage_recovery_required" : "auth_storage_unavailable");
        } else {
            android.util.Log.e("GuguAuthStorage", "auth_storage_failure operation=bridge reason=request_failed");
            call.reject("请重试", "auth_storage_unavailable");
        }
    }
    @PluginMethod
    public void recoveryState(PluginCall call) {
        try {
            AndroidAuthRecovery.State state = AndroidAuthRecovery.inspect(getContext());
            JSObject result = new JSObject(); result.put("canReset", state.canReset); result.put("revision", state.revision);
            call.resolve(result);
        } catch (Exception error) { reject(call, error); }
    }
    @PluginMethod
    public void resetUnreadable(PluginCall call) {
        try { AndroidAuthRecovery.reset(getContext(), call.getString("revision")); call.resolve(); }
        catch (Exception error) { reject(call, error); }
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String key = call.getString("key");
            if (!AuthStorageKeys.isAllowed(key)) { call.reject("Unsupported storage key"); return; }
            var storage = new AndroidAuthStore(getContext());
            JSObject result = new JSObject();
            synchronized (STORAGE_LOCK) { String value = storage.get(key); result.put("value", value == null ? JSObject.NULL : value); }
            call.resolve(result);
        } catch (Exception error) { reject(call, error); }
    }

    @PluginMethod
    public void write(PluginCall call) {
        try {
            String key = call.getString("key");
            if (!AuthStorageKeys.isAllowed(key)) { call.reject("Unsupported storage key"); return; }
            String value = call.getString("value");
            if (value == null) { call.reject("Missing storage value"); return; }
            var storage = new AndroidAuthStore(getContext());
            synchronized (STORAGE_LOCK) {
                if ("sb-main".equals(key)) {
                    try { AccountClosurePreparation.requireAuthWrite(getContext(), value); }
                    catch (Exception refused) { call.reject("Account closure prevents this auth write", "closure_not_prepared"); return; }
                }
                storage.put(key, value);
            }
            call.resolve();
        } catch (Exception error) { reject(call, error); }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            String key = call.getString("key");
            // Session retirement remains an explicit envelope write owned by the coordinator.
            if (!AuthStorageKeys.isTemporary(key)) { call.reject("Unsupported temporary storage key"); return; }
            var storage = new AndroidAuthStore(getContext());
            synchronized (STORAGE_LOCK) { storage.removeTemporary(key); }
            call.resolve();
        } catch (Exception error) { reject(call, error); }
    }
}
