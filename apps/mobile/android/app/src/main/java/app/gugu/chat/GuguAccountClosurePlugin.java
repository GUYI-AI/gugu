package app.gugu.chat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Sensitive payloads are never logged; Capacitor bridge logging stays disabled. */
@CapacitorPlugin(name = "GuguAccountClosure")
public class GuguAccountClosurePlugin extends Plugin {
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private AndroidAccountClosure closure;
    private interface Action { JSObject run(AndroidAccountClosure service) throws Exception; }
    private synchronized AndroidAccountClosure service() throws Exception {
        if (closure == null) closure = new AndroidAccountClosure(getContext());
        return closure;
    }
    private void perform(PluginCall call, Action action) {
        work.execute(() -> {
            try { call.resolve(action.run(service())); }
            catch (Exception error) { reject(call, error); }
        });
    }
    private static AccountClosureReceiptStore.Scope scope(PluginCall call) throws Exception {
        return new AccountClosureReceiptStore.Scope(call.getString("ownerId"), call.getString("localOperationId"));
    }
    private static void reject(PluginCall call, Throwable error) {
        while (error instanceof java.util.concurrent.CompletionException && error.getCause() != null) error = error.getCause();
        String code = error instanceof AccountClosureReceiptStore.Failure ? ((AccountClosureReceiptStore.Failure) error).code : "closure_storage_unavailable";
        call.reject("Local account closure operation could not be completed", code);
    }
    @PluginMethod public void put(PluginCall call) { perform(call, service -> { service.receipts.put(scope(call), call.getString("receipt")); return new JSObject(); }); }
    @PluginMethod public void get(PluginCall call) {
        perform(call, service -> { String value = service.receipts.get(scope(call)); return new JSObject().put("value", value == null ? JSObject.NULL : value); });
    }
    @PluginMethod public void remove(PluginCall call) { perform(call, service -> { service.receipts.remove(scope(call)); return new JSObject(); }); }
    @PluginMethod public void eraseLocal(PluginCall call) {
        perform(call, service -> { AccountClosureReceiptStore.Outcome result = service.erase(scope(call));
            JSArray names = new JSArray(); for (String name : result.retainedUnattributed) names.put(name);
            return new JSObject().put("status", result.status).put("retainedUnattributed", names); });
    }
    @PluginMethod public void prepareSignOut(PluginCall call) {
        work.execute(() -> {
            try {
                String owner = GuguAgentHostPolicy.owner(call.getString("ownerId")); AndroidAccountClosure current = service();
                current.prepareSignOut(owner).whenComplete((unused, error) -> {
                    if (error != null) reject(call, error);
                    else try { call.resolve(new JSObject().put("prepared", true).put("deviceId", current.deviceId(owner))); }
                    catch (Exception failure) { reject(call, failure); }
                });
            } catch (Exception error) { reject(call, error); }
        });
    }
    @PluginMethod public void retireDevice(PluginCall call) {
        perform(call, service -> { service.retireDevice(call.getString("ownerId"), call.getString("deviceId")); return new JSObject().put("retired", true); });
    }
    @PluginMethod public void cancelPreparation(PluginCall call) {
        perform(call, service -> { service.cancelPreparation(scope(call)); return new JSObject().put("cancelled", true); });
    }
    @Override protected void handleOnDestroy() { work.shutdown(); }
}
